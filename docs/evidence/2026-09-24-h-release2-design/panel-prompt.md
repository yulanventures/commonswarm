# Design question: CommonSwarm item H release 2 — a connect code, so the token never enters a model turn

You are a read-only design consultant. Repository: the current directory (CommonSwarm: `cswarm` CLI in src/, Deno edge
functions in supabase/functions/, migrations in supabase/migrations/, canonical spec docs/design/SWARM-CLOUD.md). The
MCP spec v20 is on the local branch `spec/mcp-server` (read it with `git show spec/mcp-server:docs/design/2026-09-14-MCP-SERVER.md`;
lane 3 is roughly lines 649-993). Do not contact api.commonswarm.com or commonswarm.com, do not run cswarm. You may
search the web for host documentation (Claude Code, Codex MCP configuration).

## Where we are
- Release 1 shipped (cswarm 0.1.74): `cswarm mcp --profile <path> [--host-session-id <id>]`, seven tools over stdio;
  the profile is written beforehand by `cswarm setup --connection-file <file>`. Brief: docs/design/2026-09-23-MCP-LANE-2-BRIEF.md.
- Item I shipped (0.1.75): `cswarm setup` needs `--host-session-id <id>` or `manual`; a bound profile refuses another
  session (`profile_other_session`) or a missing id (`host_session_required`) before any credential or network use.
  Brief: docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md.
- Strategist ruling: item H stays OPEN until release 2 = "connect code, token never in a model turn". Done-test (v20
  section 4): a fresh Claude Code session and a fresh Codex session each join a workspace, read, ask and reply using only
  MCP tools and a connect code; the token never appears in a model turn; released on npm.
- Today a model turn DOES see a secret: site/src/components/connect/agent-prompt.ts `dashboardAgentPrompt` puts the
  encoded connection token in the prompt the human pastes; the file variant has the agent's own tool save the attached
  file (its bytes pass through the model); H0 link-join (src/h0/paste.ts) puts a `swm_join_` secret in the paste text.
- v20 lane 3 says: the OPERATOR runs `cswarm mcp connect <code>` (never the model); the code is issued in the web app or
  by `cswarm` under the human credential for a host session the operator NAMES at issuance; a durable Postgres record
  with the code hashed, expiry, per-workspace rate limit, atomic one-use redemption; `intended_host_session_id` at
  issuance and a durable binding at redemption with `UNIQUE (workspace_id, host_session_id) WHERE released_at IS NULL`;
  an unbind path that revokes the credential; the credential is written to a 0600 file, never to stdout. Crash
  recovery is item M (later); release 2 is fail-closed. Review arms (docs/evidence/2026-09-23-mcp-v20-review/) said v20
  never mentions H0, and must say whether connect reuses H0's join credential and `register` (with its `attemptId` seat
  recovery) or why not.
- H0 already has: `swarm.agent_join_credentials` (hashed `swm_join_` secret, locator, seat_cap, 1-24 h TTL, per-user and
  per-workspace limits; migration 20260916000001), `mint_agent_join_credential` / `revoke_agent_join_credential`, and the
  h0 `register` verb (join credential -> seat token once, `attemptId` retry recovers an unused seat).
- A migration or edge change needs a box release (deploy/RELEASE-TO-BOX.md: the lead prepares, HezLead directs, Anvil
  applies). A client-only change needs only npm.

## Questions (answer each; cite files; say what you verified vs assumed)
1. How does a HUMAN run connect on the agent's host with the least effort, so no secret passes through a model turn?
   For Claude Code and Codex specifically: the human's own terminal (`cswarm mcp connect <code>` then
   `claude mcp add ...` / Codex config), a one-line installer, or the MCP server doing the redemption on first start from
   a code in its static config or environment (does the code then sit in a config file the model can read, and does that
   matter if it is one-use and short-lived?). Which of these keeps the code and the token out of every model turn?
2. Host session binding: a static MCP host config cannot pass a per-session id (unverified for Claude Code
   `${CLAUDE_CODE_SESSION_ID}` expansion in MCP args — check the docs). Should an operator-run connect write a `manual`
   (unbound) profile, bind to a host session the operator names, or something else? Does v20's server-side
   `intended_host_session_id` + partial unique index still earn its cost after item I's client-side binding?
3. Reuse H0 or build new: can `agent_join_credentials` + h0 `register` be the connect code (seat_cap 1, short TTL,
   attemptId recovery) with a CLI redeemer, and what would be missing (the code format for a human to type, the host
   session field, the unbind path)? Or is a new table cleaner? Which option avoids a migration / box release for
   release 2, and is that honest against the done-test?
4. The minimal release 2 you recommend: exact flow for the human (steps and what they type), the CLI verb(s), server
   pieces (reused or new), what the model sees, tests and the production control, what it deliberately does not do
   (item M crash safety), and whether it needs a box release.

Answer in under 1,300 words. End with one line: RECOMMENDATION: <one sentence>.
