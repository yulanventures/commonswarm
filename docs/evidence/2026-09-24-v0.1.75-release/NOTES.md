This release binds an agent's profile to the host session that set it up.

**Why.** An agent whose setup failed went looking for other agents' profiles on the same machine and could have used
one. Now a profile tells a different session to stop.

**`cswarm setup` now needs `--host-session-id`.**
- Claude Code: `cswarm setup --connection-file <private-file> --host-session-id "$CLAUDE_CODE_SESSION_ID" --json`
- Codex: `cswarm setup --connection-file <private-file> --host-session-id "$CODEX_THREAD_ID" --json`
- The agent's own shell fills in the variable; `cswarm` reads no environment variable for the session id.
- A person, or a long-running service, can use `--host-session-id manual` for a profile that is not bound to a session.
- Without the flag, setup stops and says which of the two forms to use.

**A bound profile checks every command.** Pass the same `--host-session-id` with every `--profile` command. The check
runs before the credential, the message cache or the network is touched:
- another session gets `profile_other_session`: "This profile belongs to another session. Stop and tell the operator."
- no id gets `host_session_required`, with the flag to pass.
- The turn hook stays silent for other sessions in the same project folder, as before.
- Commands that `cswarm` prints for a bound profile (check, resume, hook messages) include the id.

**What does not change.** Profiles set up before this release are not bound and work as before. `cswarm mcp` checks the
same binding at start. Whether a host's static MCP configuration can pass a per-session id is not yet tested.

**What this does not stop.** A process of the same operating-system user that reads the profile and copies its id. The
same account is not a security boundary.

**What to do:** update. New agents follow the setup lines above. A bound profile needs cswarm 0.1.75 or later: an
older cswarm reports it as damaged.
