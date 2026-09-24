# Item I — Checker review (Claude Opus arm), round 1

Lane `lane/item-i` at `5fe61316` (d1d586a4 + 5fe61316), base `0260ab8d`. Work copies: `git archive` of both SHAs under
`scratchpad/itemI/opus-probes/{lane,base}`, built with `npm run build` (exit 0 both). Temporary HOME for every run.
No production host, no ssh/supabase/vercel, no real workspace, no other model CLI. Every fake edge and CLI child was
killed (`pgrep -f fake-edge` empty after each probe).

Probe files (scratchpad, not tracked): `rows.mjs` (row dump from `AGENT_COMMANDS` in the built lane), `harness.mjs`
(every `--profile`-accepting row × {session-B, no id, session-A}, fresh profile each run, loopback fake edge that counts
requests, `--require trace.cjs` preload that logs every fs read/open/write under the fixture dir and every `fetch`),
`hookprobe.sh` (real `receive configure --provider claude` then the installed hook command, fed Claude-shaped stdin),
`mut/` (mutation copy). Results: `lane-bound-results.json`, `lane-unbound-results.json`, `base-unbound-results.json`,
`mut-M*.log`, `baseline-tests.log`.

## Findings

### 1. PRODUCTION — the turn hook now announces a refusal to every other session in the same project, and tells it to open the other agent's profile

`src/onboarding-cli.ts:112-116`
```ts
const stdinSessionId = event && typeof event === "object" && ... ? (event as Record<string, string>).session_id : undefined;
await readAgentProfile(profile, stdinSessionId);
const result = await receiveHookEvent(profile, host, event);
```
The hook is installed into the project, not the session: `src/cloud/agent-receive.ts:182` writes
`<cwd>/.claude/settings.local.json` (Codex: `.codex/hooks.json`), and `mergeReceiveHooks` keeps every other agent's hook.
So every Claude Code session opened in that directory runs seat A's hook with its OWN stdin `session_id`. At base,
`receiveHookEvent` (`agent-receive.ts:272`, `event.session_id !== binding.host_session_id → { check: false }`) ignored it
silently. The lane compares the stdin id with the binding first and throws; the catch-all (`onboarding-cli.ts:126-134`)
turns that into host-turn text from `turnHookFailureText` (`:74`), which names A's profile path and no host id.

Measured (`hookprobe.sh`, same sequence of five turns in one project dir, fake edge):
```
[base]         turn by session-B: exit=0 requests=0 stdout=<empty>
[base]         turn by session-A: exit=0 requests=2 stdout=<empty>
[lane-unbound] (identical to base)
[lane-bound]   turn by session-B: stdout=CommonSwarm check failed (profile_other_session); the inbox was not proved empty. Run cswarm check --profile '<T>/p/profile.json' to see the error.
[lane-bound]   turn by session-A: requests=2 stdout=CommonSwarm message checks are working again.
[lane-bound]   turn by session-B: stdout=CommonSwarm check failed (profile_other_session); ... Run cswarm check --profile '<T>/p/profile.json' ...
[lane-bound]   turn by session-B: stdout=<empty>
[lane-bound]   turn by session-A: requests=2 stdout=CommonSwarm message checks are working again.
```
Consequences, for every bound seat that picks turn checks (the default path the connect prompt steers to):
- Session B is told its CommonSwarm check failed and is given a command that opens seat A's profile. The feature exists
  to stop exactly that.
- Both sessions share the diagnostic file `check-error-<sha(arg host)>.json` (`:104`), so A and B alternate:
  B gets a failure after each A turn, and A gets "CommonSwarm message checks are working again." after each B turn.
- With N seats in one repo (this fleet's normal layout), every session sees up to N-1 of these per turn.

The hook must present stdin `session_id` (decision 2), but a stdin id that does not match the configured
`--host-session-id` is another session's turn, not an attack. It should exit silently as it did at base. Then
`requireProfileHost(profile, host)`. A missing stdin id is still `host_session_required`. The item-I hook test
(`tests/p1-cli/item-i-profile-binding.test.ts:165-177`) asserts the noisy output as correct (`/profile_other_session/`
in stdout for B).

### 2. PRODUCTION — a bound profile cannot use `listen start|status|stop|canary` or `session status|stop` at all

The rows use `EXPAND_PROFILE_KEEP_HOST` (`src/cli.ts:9427-9437`), so the host flag is left for the handler. The
handlers' `assertShape` lists do not include `host-session-id` (`runListenStart` `src/cli.ts:6896`,
`runListenStatusOrStop` `:7253`, `runListenCanary` `:7362`, `runSession` status/stop). For a bound profile:
- without the id: `This profile is bound to a host session. Pass --host-session-id with this session's id.`
- with the id, as that sentence says: `cswarm: unknown option: --host-session-id`.

Measured with a bound profile and session A (`lane-bound-results.json`, plus a direct run for `listen start`):
```
listen start   st=1 cswarm: unknown option: --host-session-id
listen status  st=1 cswarm: unknown option: --host-session-id
listen stop    st=1 cswarm: unknown option: --host-session-id
listen canary  st=1 cswarm: unknown option: --host-session-id
session status st=1 cswarm: unknown option: --host-session-id
session stop   st=1 cswarm: unknown option: --host-session-id
(session enable|disable|recover: same; those also never worked with --profile at base)
```
At base, with the same profile unbound and no id, `listen status`/`listen stop` returned `{"status":"not_found",...}`
and `listen canary` reached the edge. So every seat set up through the new connect prompt loses the optional local
listener, and the refusal's next step is false. The generated coverage test cannot see this: it only asserts that
session B is refused, and a row that refuses everyone passes it (see 6).

### 3. RIGOUR — `receive configure` with no id on a bound profile says "another session"

`src/cloud/agent-receive.ts:208` `const host = checkedHostSessionId(options.hostSessionId);` maps undefined to
`"manual"`. Then `:220` `await readAgentProfile(profile, host);` compares `"manual"` with the binding. Measured:
`receive configure --profile <bound> --mode turn --json` (no id) →
`{"code":"profile_other_session","message":"This profile belongs to another session. Stop and tell the operator."}`.
Decision 2 requires `host_session_required` here, and the brief says why: "the same session may have forgotten the
flag, so 'another session' would be false". Pass `options.hostSessionId` rather than `host` to `readAgentProfile`.

### 4. RIGOUR — next steps that omit `--host-session-id`, and so fail on every bound profile

Each of these is refused with `host_session_required` when followed as written:
- `src/onboarding-cli.ts:74-76` `turnHookFailureText`: "Run cswarm check --profile <p> to see the error." For a bound
  seat's own session, this hides the real error behind `host_session_required`.
- `src/onboarding-cli.ts:256` `instruction: turnCheckInstruction(path, binding?.host_session_id)`: when there is no
  receive binding yet, the id is dropped. Measured: `resume --profile <bound> --host-session-id session-A --json` →
  `instruction`: `At each turn's start and when asked, run cswarm check --profile '<T>/p/profile.json'. ...` (no id).
  Use the profile's `host_session_id` (or the presented id).
- `site/public/skills/cswarm/SKILL.md:12`, `:14`, `:16`: `cswarm check --profile <profile>`,
  `cswarm reply <signal-id> <answer> --profile <profile>`, `cswarm brain put ... --profile <profile>`. The new line 5
  says to pass the id with every `--profile` command, but the concrete commands below it do not.
- `src/cloud/agent-setup.ts:84-85` `next_action` "Read new messages with cswarm check" names no flags. Weaker, but it is
  the first command after a bound setup.
The refusal tells the agent what to add, so each case can be recovered. But this is the "Honesty is not sufficient"
pattern: the guidance the agent is given does not work.

### 5. RIGOUR — the claim "the CLI reads no host environment variable" is false as written

`src/cloud/agent-onboarding-contract.ts:44` (served by `setup guide`, the quick guide, and the site connect prompt):
"The shell expands the variable; the CLI reads no host environment variable." But `setup` calls `detectAgentHost()`
(`agent-setup.ts:43`), which reads `env.CURSOR_AGENT`, `env.SAND_HOST_PORT`, and `env.CURSOR_AGENT_SOCKET`
(`src/cloud/agent-host.ts:21`). `src/cli.ts:7789` reads `process.env.CLAUDE_CONFIG_DIR`. The claim the code supports is
narrower: the CLI reads no environment variable for the session id. `grep` for `CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID`
in `src/` finds only the guidance string. Under "Claim controls prove stability, not truth", the test that pins this
text (`tests/p1-cli/permissions-default.test.ts`) protects a false sentence.

### 6. RIGOUR — the generated coverage test checks refusal, not order or a positive path

`tests/p1-cli/item-i-profile-binding.test.ts:179-203` is generated from `AGENT_COMMANDS` (42 rows; my own dump also
finds 42). What the mutation copy shows:
- M1, comparison replaced with `if (false)` (`agent-profile.ts:54`): 5/7 tests fail. The B test fails with
  `actual code: 'check_state_invalid'` (it reached the damaged cache), so it reaches the path. PASS as a control.
- M2, a new NATIVE `--profile` row whose handler `readFile`+`JSON.parse`s the profile: the generated test fails with
  `peek: {..."message":"bbbbbbbb-...\n"}`. The table-driven claim holds.
- M4, the hook presents `host` instead of the stdin id: the hook test fails. Holds.
- M3, `expandAgentProfile` reads the credential BEFORE `readAgentProfile(path, id)`: **all 7 tests pass (exit 0)**.
  So for the 36 EXPAND rows the promise "before reading the credential" has no control. Only `checkAgentMessages`
  and `cachedAgentMessage` are tested with damaged files. The shipped order is correct (see the verified list), but
  nothing guards it.
- The loop has no A (matching id) control per row, which is how finding 2 passed.
Suggested: in the generated loop, damage `credential.json`, `check.json`, and `receive-*.json`; assert B's code AND
that a session-A run does not end with `unknown option` or `host_session_required`.

### 7. RIGOUR (needs a ruling) — setup silently binds an existing unbound or `manual` profile

`src/cloud/agent-setup.ts:34-37` refuses only a bound profile. `saveAgentProfile` (`agent-profile.ts:251`) then writes
the new id. Measured by accident in the first harness pass: after `setup --host-session-id session-B` on an unbound
profile, the next `check --profile` with no id returned `host_session_required`, so the profile was now bound to B.
Decision 3 covers only bound profiles. But the default profile path depends only on the connection
(`defaultAgentProfilePath`), so re-running the connect prompt from any session converts an operator's `manual`
profile (for example, a listener service) into one bound to that session. The service then fails on its next start
with `host_session_required`. `manual` → bound is allowed, but bound → `manual` is refused. Decide whether that
asymmetry is intended, and write it in the release notes.

### 8. RIGOUR — small writes into A's profile directory happen before the check

Traced for session B (`lane-bound-results.json`): `receive test` and `receive idle` open
`<A's dir>/receive-<sha(B)>.lock` before the refusal, because `updateReceiveBinding` takes the lock
(`agent-receive.ts:86`) before `readReceiveBinding` checks. The hook's catch writes `check-error-<sha>.json` into A's
directory on every refusal (finding 1). The trace shows no credential read, no cache read, and no request. But
LANE.md:6 says the check comes before "receive state", and these writes are into that directory.

### 9. RIGOUR — some setup failures lack the operator step

`src/onboarding-cli.ts:148-156` adds "Stop and tell the operator. Do not open another agent's profile." only to an
`AgentSetupError` or an `AgentCredentialInputError`. Network and HTTP failures pass through unchanged. The updated
dispatch baseline row `setup.import` shows this:
`"message":"member read failed (HTTP 400): fixture_boundary"`, with no step. Decision 4 says setup failures end with it.

### 10. Host variables — what was and was not verified

- `CLAUDE_CODE_SESSION_ID`: **measured** in this Claude Code Bash tool shell (desktop entrypoint). It is present,
  36-character UUID-shaped, and matches this session's transcript name, which is the id Claude Code hooks send. Direct
  equality with hook stdin `session_id` was not measured. The `code.claude.com/docs/en/env-vars` page was truncated when
  fetched and did not show a row for it, so LANE.md's doc citation is NOT verified. Also measured: this subagent's
  shell carries the PARENT session's id (prefix `348bdb35`), so subagents and any child that inherits the variable pass
  as session A. That fits the brief's same-OS-user limit, but it relies on an inherited variable, which the identity
  spec says not to trust.
- `CODEX_THREAD_ID`: `codex-rs/core/src/exec_env.rs` (fetched) says "`CODEX_THREAD_ID` is injected when a thread id is
  provided". NOT established: that every Codex shell has one, and that it equals the `session_id` in Codex hook stdin.
  If they differ, every Codex turn hook on a bound profile refuses (finding 1 path).
- NOT established: what happens to either id after `/clear`, `claude --resume` (the wake `start_command` depends on
  it), or Codex resume. A changed id locks the seat out until the operator removes the profile directory.
- `cswarm mcp` with a static host config: an unbound profile behaves as at base (measured). A bound profile needs a
  per-session `--host-session-id` in the static config, and no one has shown that this works. LANE.md:9 states this
  correctly.

## Verified (with measurements)

- **Openers.** `readAgentProfile` is the only profile reader in `src/` (enumerated: `cli.ts:766`, `mcp/server.ts:34`,
  `agent-setup.ts:36`, `agent-profile.ts:212`, `agent-receive.ts:58,220`, `agent-check.ts:153,255`,
  `agent-channel.ts:89`, `onboarding-cli.ts:116,252`). The `grok-bot` idle/serve and channel confirm paths go through
  `readReceiveBinding`. `hook check|install|uninstall` and the other REFUSE rows take no `--profile`.
- **B, 42 of 42 rows:** refused with the exact sentence "This profile belongs to another session. Stop and tell the
  operator." The fake edge counted 0 requests and the preload counted 0 `fetch` calls. The trace shows no
  `credential.json` read and no `check.json` or `receive-*.json` read (exceptions: the lock files in finding 8).
- **No id:** the exact `host_session_required` sentence on 33 rows, 0 requests. `receive test|confirm|idle|serve`
  require the flag by parser. `receive configure` gives the wrong code (finding 3). `setup` gives
  `setup_host_session_required`, and its sentence names both `--host-session-id <this-session-id>` and `manual`.
- **A (positive control):** 21 rows reached the fake edge (setup, check, whoami, members, feed, inbox, channel/file/brain
  reads, the posts, receipt). mcp started (exit 0 on stdin EOF).
- **Unbound profile vs base, same fixture, per row, id B and no id:** 79 of 80 outputs are identical after normalizing
  paths. The one difference is `setup` without an id (intended). The unbound hook sequence is identical to base.
- **Setup rebind:** B on a bound profile is refused before network (0 requests). The only read is B's own connection file.
- **Old CLI:** the base CLI on a bound profile gives `profile_invalid` (it fails closed). An empty id gives
  `host_session_invalid`.
- **Dispatch baseline:** 7 rows changed. 5 help texts gain the `--host-session-id <id|manual>` usage line.
  `setup.guide` has the new guide. `setup.import` gains `--host-session-id manual`, and its `handlers` stay
  `["runOnboardingCommand:setup-import"]`, so it still reaches setup. All seven changes are intended.
- **Surfaces with a setup command** (`site/src`, `site/public`, `src`, README, `npm/`, `llms.txt`, `api.md`): each
  includes `--host-session-id`. That is `agent-prompt.ts` through `AGENT_SETUP_HOST_GUIDANCE`, the guide, the usage
  text, and `SKILL.md:5`. The commands without it are the check/reply/brain examples in finding 4. `dist-npm/cswarm.cjs`
  is the old release bundle. `docs/evidence`/`docs/org` are history.
- **Tests:** the six changed or added p1-cli files pass 61/61 (`baseline-tests.log`). The site connect test passes
  11/11. The item-I file matches the literal `tests/p1-cli/**/*.test.ts` glob of `test:p1-cli`, and no subdirectory
  holds a `.test.ts`, so node expands the glob. The site observer test matches the site `test` glob.
- **Server:** no change, as decision 6 requires.

## Not established by this review

No production control (the lead owns it). The full `npm test` and `test:p1-cli` suites were not run; only the changed
files were. No live Claude Code or Codex hook run with the real host. The equality of hook stdin ids with the shell
variables was not measured (see 10).

VERDICT: FAIL
