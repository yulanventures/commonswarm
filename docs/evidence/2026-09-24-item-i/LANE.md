# Item I release 1 implementation lane (2026-09-24)

## Built against the six decisions

1. Setup now requires an explicit `--host-session-id <id>` or `--host-session-id manual`. It records `host_session_id` for a named session and leaves manual profiles unbound. The reader accepts the original six keys, those keys with `workspace_name`, and either form with `host_session_id`; a bound id must be a string of 1–200 characters. No host variable is read by the CLI. An older CLI will reject the new key as a damaged profile, so the release note must say: **bound profiles need cswarm 0.1.75 or newer**.
2. `requireProfileHost` in `src/cloud/agent-profile.ts` is the single comparison. `readAgentProfile` calls it for all profile openers, before credential, message cache, receive state, or network use. B gets `profile_other_session` with the specified sentence; an omitted id gets `host_session_required` with its distinct sentence. Unbound profiles keep their prior behavior. `check --hook` also presents the hook stdin `session_id` before opening receive state.
3. Setup checks an existing profile before making its identity request. A different id, including `manual`, cannot rebind an existing bound profile. Moving a seat requires the operator to remove the profile directory and set it up again.
4. The connection token repair copy, setup CLI errors, quick guide, setup guide, and site connect prompt give the operator step and show explicit setup commands. The prompt names only the two hosts verified from their own sources: Claude Code documents `CLAUDE_CODE_SESSION_ID` in shell and hook subprocesses in its [environment reference](https://code.claude.com/docs/en/env-vars); Codex injects `CODEX_THREAD_ID` when a thread ID is provided in its [shell environment source](https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_env.rs). Both examples rely on the agent's shell to expand the variable. No other host variable was established, so no other host is named.
5. MCP checks the profile at startup, before listing managed contexts or creating a transport. Its error table maps `profile_other_session` and `host_session_required` to a person step. A static host MCP configuration's ability to pass a per-session ID remains unestablished; the Claude Code live run must check it before claiming MCP works for a bound profile.
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
