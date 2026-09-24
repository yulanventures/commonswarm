I'll read the MCP spec, the shipped briefs, and the current connect and H0 paths, then check Claude Code and Codex host docs for how a human can redeem a code without putting a secret in a model turn.Lane 3 is operator-run redemption into a 0600 profile. Next I’ll check the shipped profile binding, H0 join credentials, and how Claude Code and Codex actually store MCP config.Release 2 is an npm-only CLI. The human mints a one-seat H0 join code and redeems it in their own terminal into an unbound 0600 profile. The model then sees only the MCP tools that 0.1.74 already serves.

## 1. Where the human runs connect

The human runs both commands in their own terminal, outside the agent session, and redeems before that session starts.

Three paths leak a secret into a model turn today. `dashboardAgentPrompt` appends the encoded connection token to the paste (`site/src/components/connect/agent-prompt.ts:50-53`). The file variant tells the model to save the attachment (`:45-47`). `h0AgentPaste` puts `swm_join_…` on its own line for the model to send to `register` (`src/h0/paste.ts:136-141`).

Claude Code stores stdio servers in user `~/.claude.json` or project `.mcp.json`, and expands `${VAR}` and `${VAR:-default}` in `command`, `args`, and `env` (Claude Code MCP docs, page dated 2026-09-23). Codex stores `[mcp_servers.*]` in `~/.codex/config.toml` or project `.codex/config.toml`, with literal `env` values and `env_vars` names (OpenAI Codex MCP docs, page dated 2026-07-09). That Codex page does not document `${}` expansion in `args`. GitHub issue openai/codex#7521 (2025-12-03) asks for it; I did not confirm a later addition.

A code placed in either config file is readable by the model. Project files sit in the workspace, and both hosts give the model a shell that can read the user-level file. A one-hour, one-use code is already spent after a successful redeem, and it is still live if the model reads the file first or redeem fails and the line stays on disk. v20 removed host-side redemption for this reason: operator `cswarm mcp connect <code>` is the only redemption path (lane 3 on `spec/mcp-server`, `c72f0916`).

A one-line installer is the same human-terminal command with the host config bundled in. It becomes a model-turn leak the moment the human pastes that line into the agent.

`cswarm mcp connect <code>` lands in the human's shell history. With `seat_cap` 1, that entry is a spent bearer: a new `attemptId` cannot take another seat (`supabase/functions/command/index.ts`, the `seats_used < seat_cap` update). The seat token stays out of history when the CLI never prints it.

## 2. Host session

Connect writes an unbound profile. `saveAgentProfile` omits `host_session_id` for `manual` (`src/cloud/agent-profile.ts:207`). `requireProfileHost` returns immediately when the key is absent (`:49-50`). `cswarm mcp --host-session-id manual` is refused with `host_session_invalid` (`src/mcp/server.ts:39-41`). The install line is `cswarm mcp --profile <absolute-path>` and carries no session flag.

Claude's documented expansion could pass `${CLAUDE_CODE_SESSION_ID}` in args. The MCP docs name `${CLAUDE_PROJECT_DIR}` and generic `${VAR}`. They do not say `CLAUDE_CODE_SESSION_ID` is set in the process that expands config, rather than in the shell inside a turn (`AGENT_SETUP_HOST_GUIDANCE`, `src/cloud/agent-onboarding-contract.ts:44`). Codex's MCP page shows neither arg expansion nor `CODEX_THREAD_ID`. Both stay unverified, as the item I brief already says (decision 5).

A profile bound to one id fails on the next session, because static config would have to carry that exact id. One install line for a fresh session needs an unbound profile.

v20's `intended_host_session_id` and `UNIQUE (workspace_id, host_session_id) WHERE released_at IS NULL` still do something item I cannot. Item I compares one local file with the id it is shown. It cannot see a second profile, or an older `mcpServers` entry, for the same session string. An unbound profile gives that index nothing to store. The index earns a migration when a later release binds sessions. It does not earn one here.

## 3. Reuse H0

Reuse `mint_agent_join_credential` and H0 `register`. A new table is the wrong shape for this release.

Already on the box:

- `swarm.agent_join_credentials` stores the SHA-256 of the full `swm_join_` secret, a public locator, `seat_cap` 1–10, a 1–24 hour TTL, and live ceilings of 5 per user and 20 per workspace (`supabase/migrations/20260916000001_agent_join_credentials.sql`, `src/protocol/agent-join-limits.ts`).
- Mint persists the caller's `seat_cap` and `ttl_hours`. The site helper always sends the maximum (`mintAgentJoinCredentialCommand`). A CLI mint can send 1 and 1.
- `POST /h0/register` (`supabase/functions/h0/parse.ts`) spends one seat and returns `agent_token` (`swm_agt_`) once, with `principal_id`, `run_id`, `token_id`, `expires_at`, and `workspace_id`.
- `h0_seat_uses_poll` guards only `claim_agent_inbox` (`supabase/functions/command/h0-seat.ts`, one call site in `command/index.ts`). Registered scopes include `post_signal`. I did not run `check` or `ask` as an H0 seat. The 2026-09-23 Opus arm left that read path unproven. The production control below is the proof.

Left out on purpose:

- A short code. The secret is `swm_join_` plus 43 base64url characters (`src/h0/paste.ts:9`). The human pastes it. A short code needs a new lookup and a redemption rate limit. The 256-bit secret is why this release can live with the existing mint ceilings and no redemption limiter.
- `intended_host_session_id`. That column does not exist.
- Unbind of a host-session row. `revoke_agent_join_credential` leaves seats that already registered (comment at `command/index.ts:6696`). Seat unbind is the existing `cswarm principal revoke --principal-id` and `cswarm token revoke --token-id`.
- `attemptId` recovery stays server-side (`supabase/migrations/20260916000002_agent_join_attempts.sql` replaces an unused token). The release 2 CLI generates one attempt id and does not send it again. Calling that recovery would ship part of item M.

No migration and no edge release. This matches the §4 done-test: a connect code, MCP tools only after bootstrap, the token absent from the model turn, npm, and a production control. It does not implement v20's server-side session binding. The review arms asked the spec to say whether connect reuses H0. This answer is yes, and the CLI does not use `attemptId` retry.

The register body is not a credential artifact. The CLI builds the six required fields (`src/cloud/agent-credential-input.ts:53-60`) and calls `saveAgentProfile`. URL and anon key come from the cloud target already selected on that machine (`src/cloud/current-target.ts`). That last part is an assumption: the redeeming machine must already have a target. The anon key is the public one.

The H0 seat token lifetime is the protocol's 30-day maximum (`src/protocol/workspace-commands.ts:27-31`). The renewal client refuses a successor longer than 8 hours (`src/cloud/renewal.ts:68`). A fresh token is not due, so the done-test session does not renew. I did not verify a later renewal of a 30-day H0 grant.

## 4. The release

Human, in a terminal that is not the agent session:

1. Where they are already signed in, `cswarm mcp code` sends `mint_agent_join_credential` with `seat_cap` 1 and `ttl_hours` 1. Stdout shows the code once and the `join_credential_id`.
2. On the agent host, `cswarm mcp connect <code>` calls `register` once with a fresh `attemptId` and a display name such as `MCP`. It writes `credential.json`, then `profile.json`, mode 0600, with no `host_session_id`. Stdout is the profile path, `principal_id`, and the two install snippets. Neither secret is printed.
3. `claude mcp add --scope user --transport stdio cswarm -- cswarm mcp --profile <path>`.
4. The same args in user `~/.codex/config.toml` under `[mcp_servers.cswarm]`.
5. A fresh Claude Code session and a fresh Codex session use the seven tools.

The model sees those tools and their results. The code and the seat token are not in arguments, results, or prompt text.

Tests: connect's stdout and stderr contain neither prefix; both files are 0600; a second connect gets the seat-cap refusal and writes nothing; an expired or unknown code stops and does not open another profile. The new test file is on the literal `npm run test:p1-cli` list. Production control: one live redeem, then each host calls `whoami`, `check`, `ask`, and `reply`, and the transcripts contain neither prefix. That run is also the first proof an H0 seat can use the read edge.

No box release. Schema and edge stay as they are. npm is the release. `dashboardAgentPrompt` and `h0AgentPaste` still hand a secret to a model; changing those screens is a later site release.

Left for item M: no retry, no second use of `attemptId`, and no `token_id` check on the profile. A connect that dies after the server commits and before the write strands a seat. The operator revokes it from the member list when they can see that principal. I did not verify the members UI labels H0 seats. Also left out: server session binding, a short code, and a redemption-attempt limiter.

RECOMMENDATION: Ship an npm-only CLI that mints a one-seat, one-hour `swm_join_` code and has the human run `cswarm mcp connect` in their own terminal, redeeming H0 `register` once into an unbound 0600 profile and printing only install lines.
