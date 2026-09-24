# Item I brief: a profile is bound to the host session that ran setup (2026-09-24)

Written by CSwarmDevLead. Backlog row: brain `app-backlog`, item I. Order (Strategist, 2026-09-24): I, then H release 2,
then J, then G. Design input: an Alloy panel (codex, grok, antigravity; claude failed to sign in), all three
recommending the hybrid below; answers in `docs/evidence/2026-09-24-item-i-design/`.

## What is true today (origin/main 4b3c24b2)

- `cswarm setup` writes `profile.json` and `credential.json`; it records no host session. `readAgentProfile` accepts
  exactly two key sets (`src/cloud/agent-profile.ts`).
- `profileSessionContext(profile, id)` returns null when no id is given, even for a managed principal; an id that
  matches no live managed context throws `profile_session_conflict` (local).
- The command edge requires the session proof only for MANAGED principals (`managed_at`, set by a human with
  `cswarm session enable`). The read edge never checks a proof; `cswarm check` uses only the read edge.
- Host session sources in the CLI: the `--host-session-id` flag, and Claude Code hook stdin `session_id` in
  `cswarm hook check`. cswarm reads no environment variable for the session id (identity spec: do not infer host identity from inherited
  variables).
- So session B can run `cswarm check --profile <A's profile>` today and read A's messages, unless A is managed AND B
  passes its own id.

## Decisions for release 1

1. **Binding.** `cswarm setup --host-session-id <id>` writes a new optional profile key `host_session_id` (the id as
   given). `--host-session-id manual` writes no binding (a person, or a long-running service, set it up on purpose).
   `setup` with no `--host-session-id` is refused with a typed code whose sentence names both forms; it never guesses.
   `readAgentProfile` accepts a third key set (required + optional `workspace_name` + `host_session_id`), with the id
   checked for type and length. An older CLI refuses a bound profile as damaged; that is accepted (it cannot skip the
   check), and the release notes say bound profiles need 0.1.75.
2. **The rule.** When a profile has `host_session_id`, every command that opens it (every `--profile` row in
   `AGENT_COMMANDS`, `cswarm mcp`, and the hook paths that resolve a profile) compares the presented id with it BEFORE
   reading the credential or the message cache and before any network call, in ONE function
   (`requireProfileHost` in `agent-profile.ts`) that every opener calls:
   - a different id: `profile_other_session`, sentence exactly
     "This profile belongs to another session. Stop and tell the operator.";
   - no id: `host_session_required`, sentence "This profile is bound to a host session. Pass --host-session-id with
     this session's id." (the same session may have forgotten the flag, so "another session" would be false);
   - the hook path presents the stdin `session_id` when it matches the configured session. A turn for another session, including one with no stdin id, exits silently.
   An unbound profile (every profile written before this release, and `manual`) behaves exactly as today.
3. **No rebinding by setup.** `setup` on an existing bound profile with a different id is refused with
   `profile_other_session`. Moving a seat to a new session is the operator's: remove the profile directory and set the
   seat up again. Nothing binds on first use (all three panelists: that would give the profile to whichever session
   finds it first).
4. **The same next step everywhere.** The connection-token repair text (`REPAIR_USE_SETUP_FILE` and the
   `token_checksum_invalid` path in `src/cloud/agent-connection-token.ts`) and setup failures end with "Stop and tell
   the operator. Do not open another agent's profile." `AGENT_QUICK_GUIDE` / `setup guide`
   (`src/cloud/agent-onboarding-contract.ts`) and the connect message (`site/src/components/connect/agent-prompt.ts`)
   state the rule and show the setup command with `--host-session-id`, naming where each supported host exposes its id
   (Claude Code: `"$CLAUDE_CODE_SESSION_ID"` in its shell; Codex: `"$CODEX_THREAD_ID"`), as text the agent's own shell
   expands. cswarm reads no environment variable for the session id. Every host named must be verified before the text
   ships; a host that is not verified is not named.
5. **MCP.** `cswarm mcp` calls `requireProfileHost` at start (a bound profile without a matching `--host-session-id`
   does not start), and the MCP error table gives `profile_other_session` the stop-operator step and
   `host_session_required` the restart-this-MCP-session step. Whether a host's static MCP config can pass a per-session id (for example Claude Code expanding
   `${CLAUDE_CODE_SESSION_ID}` in args) is NOT established; the release notes say so and the Claude Code live run
   checks it.
6. **Server: no change.** The managed-principal proof fence stays as it is; the read edge is not changed. No box
   release.

## What this stops, and what it does not

It stops the case in the lesson: an honest agent in session B that finds another seat's profile and runs `cswarm`
with it gets a refusal that tells it to stop. It does not stop a process of the same OS user that reads or edits the
profile and replays A's id; the same OS account is not a security boundary (SWARM-CLOUD, identity spec section 1).
It does not change unbound profiles written before this release.

## Done for release 1

- Unit and CLI tests: bound to A, presented A: the fetcher is called; presented B: `profile_other_session`, fetcher
  not called, credential and cache not read; no id: `host_session_required`; unbound profile, no id: unchanged;
  `manual`: unbound; hook stdin A passes, B's turn exits silently; setup rebinding refused; an old-format profile still reads; every
  `--profile` row of `AGENT_COMMANDS` reaches `requireProfileHost` (generated from the table, not a typed list).
- Mutation control (this REPLACES the backlog's "drop the proof header, the refusal disappears", which cannot fail on
  `check`: the read edge never refuses on a proof): remove the comparison in `requireProfileHost`; the B refusal test
  fails.
- Production control: a profile bound to session A on a production seat: `cswarm check --profile` with A's id reads
  from api.commonswarm.com; with B's id and with no id it is refused before any request (a proxy or request count
  shows zero requests). Released on npm with the D-036 pair.

## Not in release 1

Server-side binding (a session-bound read proof), migrating unbound seats, and reading host environment variables in
`cswarm`. Each needs its own ruling.

## Fold 1 corrections (2026-09-24)

Decision 4's retired words were “`cswarm` itself still reads no environment variable.” That was too broad: host detection reads `CURSOR_AGENT`, `SAND_HOST_PORT`, and `CURSOR_AGENT_SOCKET`, and CLI configuration reads `CLAUDE_CONFIG_DIR`. The supported claim is: **cswarm reads no environment variable for the session id**.

An owner may run setup with an existing unbound or `manual` profile and a new session id, using the connection file; setup reports whether the resulting profile is bound. A bound profile still refuses a different id. A project-scoped hook silently ignores a turn whose stdin session id is not its configured id, including missing stdin ids. These Fold 1 rulings replace the earlier hook-missing-id line in decision 2 and its Done-list expectation.
