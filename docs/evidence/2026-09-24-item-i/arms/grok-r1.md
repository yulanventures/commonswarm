I'll review item I against the brief only: read-only git and files, no production contact, no file changes. First I'll locate the worktree, the spec, and the diff.The brief and lane record are in place. Next I’ll trace every profile opener and the exact refusal sentences against the six decisions.The receive-configure path looks like it turns a missing id into `manual` before the host check. I’ll confirm that against the comparison function, then finish the clause check.`cswarm receive configure` on a bound profile treats a missing `--host-session-id` as `manual`, so the rightful session is told the profile belongs to another session and to stop.

## PRODUCTION

**`receive configure` with no id returns `profile_other_session`.** Decision 2 says a bound profile opened with no id is `host_session_required` and the sentence "This profile is bound to a host session. Pass --host-session-id with this session's id." The other-session sentence is reserved for a different id, because a session that forgot the flag is not another session. Help marks this flag optional (`src/onboarding-cli.ts:42`). The handler passes that optional value through (`src/onboarding-cli.ts:202-204`).

`checkedHostSessionId` turns an omitted value into the manual slot before the profile is opened:

```44:49:src/cloud/agent-receive.ts
export function checkedHostSessionId(value?: string): string {
  if (value === undefined) return "manual";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new AgentSetupError("host_session_invalid", "Use the current host's session ID. Do not use a name or guess an ID.");
  }
  return value;
}
```

The default provider is `instructions`, so the early hook-provider throw does not run. The synthesized id is what `requireProfileHost` compares:

```211:220:src/cloud/agent-receive.ts
  const host = checkedHostSessionId(options.hostSessionId);
  if (provider !== "instructions" && host === "manual") throw new AgentSetupError("host_session_required", "A host hook needs this session's ID. Supply --host-session-id, or use --provider instructions for prompt-based turn checks.");
  // ...
  await readAgentProfile(profile, host);
```

```49:56:src/cloud/agent-profile.ts
export function requireProfileHost(profile: AgentProfile, hostSessionId?: string): void {
  if (profile.host_session_id === undefined) return;
  if (hostSessionId === undefined) {
    throw new AgentSetupError("host_session_required", "This profile is bound to a host session. Pass --host-session-id with this session's id.");
  }
  if (hostSessionId !== profile.host_session_id) {
    throw new AgentSetupError("profile_other_session", "This profile belongs to another session. Stop and tell the operator.");
  }
}
```

Reproduced with a profile bound to `session-A` and `configureAgentReceive({ mode: "turn" })` and no host id: code `profile_other_session`, message "This profile belongs to another session. Stop and tell the operator." Explicit `manual` is supposed to get that refusal. An omitted flag is not `manual`. `check`, `resume`, `receive status`, and `cswarm mcp` pass `undefined` through and get `host_session_required`. An unbound profile still falls through to the manual receive slot, so old profiles keep the previous configure behavior. The table test always appends `--host-session-id session-B` (`tests/p1-cli/item-i-profile-binding.test.ts:198`), so this path stays green.

With `--provider claude`, `codex`, or `grok-bot`, the omitted flag throws at line 212 before `readAgentProfile`. The code is `host_session_required`, and the sentence is "A host hook needs this session's ID. Supply --host-session-id, or use --provider instructions for prompt-based turn checks." That is the older hook sentence, not the bound-profile sentence.

## RIGOUR

**MCP next step says to restore access.** `src/mcp/errors.ts:37` maps `profile_other_session` to the exact stop sentence, then `next_step` `PERSON`: "a person must restore this agent's access outside this session" (`src/mcp/errors.ts:14`). `src/mcp/errors.ts:50` leaves `host_session_required` as "This agent requires its current host session." with the same next step. Startup itself prints the CLI sentence (`src/cli.ts:9741-9742`). The table remedy is the wrong action: stop, or start MCP again with this session's id. The shared "restore this agent's access" line describes neither.

**Skill examples omit the flag the prose requires.** `site/public/skills/cswarm/SKILL.md:8` includes `--host-session-id` on setup. Line 12 then says to run ``cswarm check --profile <profile>``. That check fails closed with `host_session_required`, and the copied command will not run on a bound profile.

**Dev probe parses `profile.json` and skips the check.** `scripts/timeout-table/probe.mjs:6-8` does `JSON.parse` on the profile file and fetches `${profile.url}/auth/v1/settings` with the anon key. It is not an `AGENT_COMMANDS` opener and does not read the inbox. `scripts/timeout-table/source-signal-read.ts:13` calls `readAgentProfile` with no id, so a bound profile still dies in `requireProfileHost` before `openProfileCredential`.

## What held

- `requireProfileHost` is the only comparison. `readAgentProfile` calls it after the key-set parse and before return (`src/cloud/agent-profile.ts:178`). Expand reads the credential only after that return (`src/cli.ts:766-767`). `check` and cached check read `check.json` only after it (`src/cloud/agent-check.ts:153-159`, `255-257`). Listen and session rows are `EXPAND_PROFILE_KEEP_HOST`, so the same expand runs before the handler. Native `check`, `resume`, `mcp`, and `readReceiveBinding` pass the caller's id in. No second production reader of `profile.json` bypasses it.
- Hook stdin is the id passed to `readAgentProfile` (`src/onboarding-cli.ts:112-116`), before `receiveHookEvent` and `checkAgentMessages`. A missing `session_id` is `undefined`, which is `host_session_required`. Session B's stdin is `profile_other_session`.
- `manual` is omitted from the file (`src/cloud/agent-profile.ts:207`). `manual` compared with a stored id is `profile_other_session`. Setup with no flag throws `setup_host_session_required` before any fetch (`src/cloud/agent-setup.ts:25-36`). A different id on an existing file is refused in that same read, and the item I test keeps the fetcher at 0. A six-key profile still reaches `message_not_cached`. On `origin/main`, the reader accepts only the six keys or those plus `workspace_name` (`agent-profile.ts:150-151` there), so a bound file is `profile_invalid` on 0.1.74. Package version is still `0.1.74`; the lane text says the release note must name 0.1.75, and this diff has no release note.
- CLI sentences match decision 2. Setup's missing-flag sentence names both forms and ends with the operator step (`src/cloud/agent-setup.ts:26`). Repair copy and `token_checksum_invalid` use `REPAIR_USE_SETUP_FILE` (`src/cloud/agent-connection-token.ts:38-39`, `207-209`). The setup wrapper appends that step except for the binding codes and `token_*` (`src/onboarding-cli.ts:148-152`).
- Claude Code's environment reference sets `CLAUDE_CODE_SESSION_ID` in Bash and PowerShell tool subprocesses. Codex `codex-rs/core/src/exec_env.rs` injects `CODEX_THREAD_ID` when a thread id is provided. The guide names only those two (`src/cloud/agent-onboarding-contract.ts:44`). `src/` does not read either variable.
- `tests/p1-cli/item-i-profile-binding.test.ts` is under the `test:p1-cli` glob. It covers A reaching the fetcher, B and a missing id refusing before the damaged cache and credential, manual, the six-key profile, setup rebind with zero fetches, hook stdin, MCP startup, and every `--profile` row from `AGENT_COMMANDS` (not a handwritten list). Replacing the `!==` comparison with `if (false)` makes the first B assertion fail with `check_state_invalid` from the damaged `check.json`, which is the path that assertion stands on.
- The seven baseline rows are the five help surfaces (the setup usage line changed by five characters to `--host-session-id <id|manual>`), `setup.guide` (the new binding paragraph), and `setup.import` (argv gains `--host-session-id manual`). `setup.import` still records handler `runOnboardingCommand:setup-import`, exit 1, and the same `onboarding_failed` / `fixture_boundary` body.
- Site prompt, `SKILL.md` setup line, `onboardingUsage`, and `AGENT_QUICK_GUIDE` all show setup with `--host-session-id`.

VERDICT: FAIL
