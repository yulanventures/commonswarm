# MCP release 2 brief: a connect code, so no secret enters a model turn (2026-09-24)

Written by CSwarmDevLead. Item H stays OPEN until this ships (Strategist, 2026-09-24). Release 1 is `cswarm mcp`
(0.1.74, `docs/design/2026-09-23-MCP-LANE-2-BRIEF.md`); item I (0.1.75) binds profiles to a host session. This brief
refreshes spec v20's lane 3 (local branch `spec/mcp-server`, c72f0916) the way the lane-2 brief refreshed lane 2.
Design input: codex and grok answers in `docs/evidence/2026-09-24-h-release2-design/` (the Alloy panel's claude,
antigravity and in-panel grok runs gave no answer).

## What is true today (origin/main 390ab66d)

- Every onboarding path hands a secret to a model turn: `dashboardAgentPrompt` puts the connection token in the pasted
  prompt; the file variant has the agent's own tool save the attached file; `h0AgentPaste` puts a `swm_join_` secret
  in the paste (site/src/components/connect/agent-prompt.ts, src/h0/paste.ts).
- H0 already has a hashed, TTL-bounded, seat-capped join credential (`swarm.agent_join_credentials`, 1-24 h,
  seat_cap 1-10, mint limits 5 per user / 20 per workspace), `mint_agent_join_credential`, and `POST h0/register`
  (join credential -> seat token once, `attemptId` retry recovers an unused seat).
- No host is proven to pass a per-session id through a static MCP config (Claude Code documents `${VAR}` expansion
  in `.mcp.json`; whether `CLAUDE_CODE_SESSION_ID` exists at expansion time is not established; Codex documents no
  argument expansion).

## Decisions (option A, recommended)

1. **The operator redeems; the model never does.** Two new verbs, both run by a person in their own terminal:
   - `cswarm mcp code` (human credential, already signed in): mints an H0 join credential with `seat_cap` 1 and
     `ttl_hours` 1 for the current workspace and prints the code once with its expiry. Exactly the existing
     `mint_agent_join_credential` command; no new server kind.
   - `cswarm mcp connect [--profile <path>]` on the agent's host: reads the code from a HIDDEN terminal prompt (echo
     off), never from argv, a file or the environment; calls `h0/register` ONCE with a fresh `attemptId` and a display
     name; writes `credential.json` then `profile.json` (0600 files, 0700 directory) through the existing
     `saveAgentProfile` path, as an UNBOUND profile (`host_session_id` absent, item I's `manual`); prints only the
     profile path, the principal id, and the two install lines. Neither the code nor the seat token is printed,
     logged, or put in an error.
2. **Install lines carry no secret:** `claude mcp add --scope user --transport stdio cswarm -- cswarm mcp --profile <path>`,
   and for Codex `[mcp_servers.cswarm] command = "cswarm", args = ["mcp", "--profile", "<path>"]`. A fresh host session
   then has the seven release-1 tools; the model sees tools and results only.
3. **Target:** the redeeming machine uses the register response's workspace plus the deployment it redeemed against
   (the code's own host); it does not guess. If the code format cannot name the deployment, connect takes `--url` and
   uses the public anon key from that deployment; the lane settles this and states it.
4. **Failure is fail-closed, not recovered (item M stays separate):** an expired, unknown, revoked or already-used code
   stops with a typed code and "Ask the operator for a new code." Connect never retries `register`, never reuses the
   `attemptId`, and never opens another profile. A connect that dies after the server commits and before the files are
   written strands one seat; the operator revokes it (`cswarm principal revoke`). A profile path that already holds a
   profile is refused before `register` (no overwrite).
5. **The onboarding surfaces stop handing secrets to the model** for the MCP path: the connect prompt and `setup guide`
   describe `mcp code` / `mcp connect` / the install line. The existing `setup --connection-file` flow and the H0 paste
   stay for hosts without MCP; their text says the secret passes through the model there. (Removing those paths is not
   in release 2.)
6. **No server change and no box release:** mint and register exist on the box today. The lane proves on production
   that an H0 seat works with the read edge (`check`, `whoami`, `members`) and posts (`ask`, `reply`); it has not been
   run before.

## What option A does not do (explicit)

- v20's server-side `intended_host_session_id` and `UNIQUE (workspace_id, host_session_id) WHERE released_at IS NULL`:
  they protect nothing while every connect profile is unbound. They come with the first release that binds MCP
  profiles to a host session (after a host passes a verified per-session id).
- A short typed code and a redemption-attempt limiter: the code is the 256-bit `swm_join_` secret, pasted into the
  hidden prompt, so guessing is not the threat.
- Crash recovery (item M).

## Option B (v20 as written)

Dedicated connect-code records with a short code, redemption throttling, `intended_host_session_id`, the partial
unique index and an unbind path: a migration and edge change, so a box release through HezLead and Anvil
(`deploy/RELEASE-TO-BOX.md`). Codex's panel answer recommends it; grok's recommends A.

## Done for release 2

Tests (tests/p1-cli, named by the package script): connect's stdout, stderr and error text never contain `swm_join_`
or `swm_agt_`; files 0600 in a 0700 directory; the code is refused from argv and read only from the hidden prompt; a
second connect with the same code gets the seat-cap refusal and writes nothing; expired / unknown / revoked codes stop
with the typed sentence; an existing profile path is refused before `register`; `mcp code` sends seat_cap 1 and
ttl_hours 1. Production control: one live `mcp code` + `mcp connect`, then a fresh Codex session and a fresh Claude Code
session each call whoami, check, ask and reply through MCP, and neither transcript contains `swm_join_` or `swm_agt_`
(the Claude Code run needs `claude` signed in on the mini). D-036 pair. Released on npm.

## Ruling needed (Strategist)

(A) npm-only release 2 on H0's join credential and `register`, unbound profiles, v20's server binding deferred to the
first bound-MCP release (recommended); or (B) v20 as written, with a migration and a box release.
