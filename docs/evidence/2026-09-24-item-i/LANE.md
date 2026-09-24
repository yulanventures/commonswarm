# Item I release 1 implementation lane (2026-09-24)

## Built against the six decisions

1. Setup now requires an explicit `--host-session-id <id>` or `--host-session-id manual`. It records `host_session_id` for a named session and leaves manual profiles unbound. The reader accepts the original six keys, those keys with `workspace_name`, and either form with `host_session_id`; a bound id must be a string of 1–200 characters. cswarm reads no environment variable for the session id. An older CLI will reject the new key as a damaged profile, so the release note must say: **bound profiles need cswarm 0.1.75 or newer**.
2. `requireProfileHost` in `src/cloud/agent-profile.ts` is the single comparison. `readAgentProfile` calls it for all profile openers, before credential, message cache, receive state, or network use. B gets `profile_other_session` with the specified sentence; an omitted id gets `host_session_required` with its distinct sentence. Unbound profiles keep their prior behavior. `check --hook` also presents the hook stdin `session_id` before opening receive state.
3. Setup checks an existing profile before making its identity request. A different id, including `manual`, cannot rebind an existing bound profile. Moving a seat requires the operator to remove the profile directory and set it up again.
4. The connection token repair copy, setup CLI errors, quick guide, setup guide, and site connect prompt give the operator step and show explicit setup commands. The prompt names Claude Code's `CLAUDE_CODE_SESSION_ID` and Codex's `CODEX_THREAD_ID`; both examples rely on the agent's shell to expand the variable. This lane did not establish equality between those shell values and live hook stdin ids, or their behavior after host resume. No other session-id variable is named.
5. MCP checks the profile at startup, before listing managed contexts or creating a transport. Fold 1 changed its error table: `profile_other_session` says stop and tell the operator; `host_session_required` says restart this MCP server with the current host session. A static host MCP configuration's ability to pass a per-session ID remains unestablished; the Claude Code live run must check it before claiming MCP works for a bound profile.
6. No server, migration, read edge, managed proof fence, or production service was changed.

## Before and after local control

- Before binding, an old-format six-key profile invoked as session B with `check --message-id` reaches `message_not_cached`. This is a local cache path with no network request, and demonstrates the old format has no host comparison. The original reader in `HEAD` had no `host_session_id` key or comparison.
- After binding the same temporary profile to A, that B command returns `profile_other_session` before the cache read. A passes the host check and reaches the fake fetcher in the network-path test; an omitted ID returns `host_session_required` before the credential and cache reads. Each CLI process had a three-second timeout and a temporary HOME.
- The earlier backlog claim that dropping a proof header would remove a `check` refusal is unsupported. `check --message-id` never makes a request or sends a proof header: before this change, B reached `message_not_cached` on an unbound profile. The source path for a fresh `check` also uses the read edge, where no session proof is required. The comparison mutation above is the control that actually exercises this release's B refusal.

## Tests and mutation control

- The item I test covers A reaching a fake fetcher, B refusing before a deliberately damaged credential and cache, the missing-ID refusal, the old format and `manual`, setup writing A's binding and refusing a rebind before fetch, setup requiring an explicit host choice and ending repair failures with the operator step, hook stdin A/B/missing behavior, MCP startup and error entries, and every `--profile`-accepting row generated from `AGENT_COMMANDS`. The table yields 42 accepting rows; each B invocation refused at profile open. The test lives under `tests/p1-cli/`, which `test:p1-cli` globs.
- Mutation control: replacing the one comparison with `if (false)` made the B-refusal test fail (exit 1). It reached `check_state_invalid` from the damaged cache instead of `profile_other_session`. The comparison was restored and the same test passed (exit 0).
- The required `npm run build` and `npm run check:tests` passed. A focused run of item I, command-table gates, connection-token, and permission-default tests passed **42/42**; the item I file alone passed **7/7**. The connect component test passed **11/11**. Each had a temporary HOME and a 120-second process timeout.
- The required `env -u FORCE_COLOR npm test` and `env -u FORCE_COLOR npm run test:p1-cli` were run with a temporary HOME and a 360-second timeout per command. Both exited 1 amid sandbox `EPERM` errors for local Unix socket, loopback bind, and spawn operations. These broad runs do not establish a passing full suite here; the focused tests above passed. A site build was not run because its `sync:installer` step writes outside this lane's allowed paths.

## Not established in this lane

- No production host was contacted; the lead owns the production A/B/no-ID request-count control. No npm release or deployment was made.
- This local guard does not stop another process under the same OS user from reading or changing the profile and replaying A's ID. Existing unbound profiles are not migrated. Server-side read proof was not added.
- The host's static MCP configuration has not been shown to expand a fresh session ID into startup arguments.

## Fold 1 (2026-09-24)

The pre-edit item I suite passed 7/7 at `5fe61316`, including an assertion that expected B's noisy hook output. That suite did not prove the reviewed acceptance criteria. The review findings below were checked against local source and temporary profiles; all ten rulings needed a change. The earlier broad statement “No host variable is read by the CLI” is retired: host detection reads `CURSOR_AGENT`, `SAND_HOST_PORT`, and `CURSOR_AGENT_SOCKET`, and CLI code reads `CLAUDE_CONFIG_DIR`. cswarm reads no environment variable for the session id.

| Ruling | Change and acceptance test | Reversion mutation result |
|---|---|---|
| F1 | The project hook silently ignores stdin session ids other than its configured id, including an absent id. `hook stdin presents its own session id` checks B's empty output and unchanged error file around A's turn. | Restoring the original stdin binding check killed the test: B spoke and wrote a diagnostic. |
| F2 | `listen` and `session` profile handlers accept the retained host flag; session status/stop also accept the expanded workspace id, and human session lifecycle rows accept expanded credential flags. The generated `AGENT_COMMANDS` test runs every profile row with B and A; B refuses and A passes argument parsing. | Removing `host-session-id` from `listen start` killed the generated A control with `unknown option`. |
| F3 | Receive configure opens the profile with the raw optional id before synthesizing `manual`, including hook providers. `receive configure keeps an omitted id distinct from manual` pins both the code and the brief's sentence. | Passing synthesized `manual` killed the test with `profile_other_session`. |
| F4 | Hook failure, resume, setup next action, receive next actions, and channel reply instructions carry the saved id; static skill, guide, and connect examples show the flag. `bound command producers include the saved id; manual commands stay unchanged` checks the enumerable producers and static copy; the site observer checks the connect prompt. | Removing the hook failure command's id killed the producer test. |
| F5 | Guidance and the brief use the narrower session-id claim; the brief retains decision 4's retired wording in a dated correction. `src never reads an environment variable as the session id` walks the TypeScript AST, with `CLAUDE_CONFIG_DIR` as a positive control; the producer test pins the corrected guide and brief. | Restoring the broad guide claim killed the producer test. |
| F6 | The expand path still opens the profile before the credential. `expand checks B before a damaged credential` gets the other-session sentence for B and a credential error for A. | Reading the damaged credential before `readAgentProfile` killed the B assertion. |
| F7 | Setup reports `host_session_bound` and permits an owner to bind a manual or legacy profile with the connection file. `setup reports the resulting binding` checks true, false, and manual-to-bound. | Forcing the result false killed the bound assertion. |
| F8 | Receive updates check the profile before taking a lock. `receive test and idle leave B's profile folder byte-identical` compares files and holds B's lock to prove refusal occurs before lock acquisition. | Removing the pre-lock check killed the test with a lock timeout instead of the profile refusal. |
| F9 | Non-`AgentSetupError` setup failures append the operator step; binding codes retain their own sentences. `setup network failures include the operator step` uses a local refused port. | Removing the generic wrapper killed the step assertion. |
| F10 | MCP maps `profile_other_session` to stop and tell the operator, and `host_session_required` to restart this MCP server with the current host session. The item I and MCP table tests pin both. | Restoring the old other-session remedy killed the item I assertion. |

### After-change local evidence

- Temporary HOME and profiles; no real workspace. `npm run build` and `npm run check:tests` passed. The item I suite passed **13/13**. Its generated table enumerated all **42** profile-accepting rows and checked B refusal plus A argument acceptance.
- The required four-file command ran with a temporary HOME: **49/51 passed**. The onboarding HTTP-fixture case could not bind `127.0.0.1` (`EPERM`), and the MCP stdio test process hit a Node native assertion after its first two tests. The isolated MCP error-table test passed **1/1**. The site connect observer passed **11/11**. These failures do not establish the remaining integration behavior.
- Ten one-at-a-time source reversions were restored after their tests; **F1–F10 each failed its named acceptance test**. The credential-before-check and transient-lock mutations were among them. A clean rebuild and item I rerun passed after restoration.

### Deployment and live verification

None. No production host, staging host, server, migration, real workspace, deployment, commit, merge, or push was touched. Production request counts, live host hook ID equality, MCP startup with a host's static config, and the blocked HTTP/MCP integration cases remain unestablished.

## Fold 2 (2026-09-24)

### Before and after acceptance evidence

- Before the edit, the new human-session test found `session enable` in `expand` mode; the generated profile test counted 42 accepting rows. `listen start --host-session-id session-A` reached its credential requirement without a profile. The unbound resume probe initially needed a temporary `HOME` to keep hook locks inside the fixture; with that fixture corrected, its revert mutation showed the missing session B flag. The typed setup probe used a local renewal rejection, so no service request was made.
- After the edit, all three human-only variants refuse `--profile` and reject `--agent-token-file` before human login. The generated profile count is 39. All six selected listener/session control rows give a usage error for `--host-session-id` without `--profile`. Resume uses the receive binding for an unbound profile and the profile id for a bound one. A typed renewal error from setup keeps the CLI's non-JSON renewal formatting and ends with the operator step.

| Ruling | Change and acceptance test | Reversion mutation result |
|---|---|---|
| G1 | `session enable`, `disable`, and `recover` use `REFUSE_PROFILE`, expose only human flags plus `principal-id`, and restore the `0260ab8d` assertion shape. `human session lifecycle refuses agent credentials before human login` checks all three profile refusals and unknown agent-token-file errors with a temporary HOME and explicit local test target. The generated all-profile test now counts 39. | Adding `CREDENTIAL_FLAGS` back to the human assertion shape made the token-file refusal fail; it reached `not logged in; run cswarm login` instead of `unknown option`. Exit 1. |
| G2 | Resume's instruction uses `profile.host_session_id ?? binding?.host_session_id`. `resume uses receive binding for unbound profile and profile binding for bound profile` checks B for the unbound receive binding and A for the bound profile. | Reverting the fallback removed `--host-session-id 'session-B'` from the unbound instruction. Exit 1. |
| G3 | The parser remembers whether `--profile` was supplied before expansion. `listen start/status/stop/canary` and `session status/stop` reject a host id without it through `UsageError`. `host session id on listener and session control rows requires profile` checks the six declared rows and usage output. | Removing the `listen start` guard made that row reach its credential requirement instead of the usage refusal. Exit 1. |
| G4 | For non-`AgentSetupError` failures, setup adds the step to the original error message and rethrows that object. `setup preserves a typed renewal failure and CLI non-JSON handling` uses a temporary connection and a local renewal rejection; it checks the renewal message, operator step, and class-specific output without a `cswarm:` error prefix. | Restoring the plain `Error` wrapper made the same typed failure print as generic `cswarm:` output. Exit 1. |

### Tests

- Required `npm run build` and `npm run check:tests` passed. The required focused command passed 30/30 after the citation test's three line pointers were moved to the current `src/cli.ts` lines. All Item I tests have explicit timeouts; CLI child processes have a three-second timeout and temporary HOME.
- Each mutation was built and run against its named focused test with a 30-second process timeout. The original sources were restored after each run, and the final restored build passed.
- The additional dispatch-baseline test could not start its loopback fixture in this sandbox: `listen EPERM ... 127.0.0.1`. Its baseline was not regenerated or claimed passing here.

### Deployment and live verification

None. No production or staging host, real workspace, deployment, commit, merge, or push was touched. Production request counts, live hook session-id equality, static MCP argument behavior, and the full suites remain unestablished.
