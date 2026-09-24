Fold 2 on item I in the CommonSwarm repo (branch lane/item-i at 4a306478). Spec: docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md.
The round-2 Opus review (FAIL) is pasted at the end. Its findings 1 and 2 are ALREADY FIXED by the lead's commit 4a306478
(guide wording "The CLI reads no environment variable for the session id"; usage errors carry no operator step;
baseline regenerated) — do not redo them. Implement EVERY ruling below, each with a test that fails when the fix is
reverted, and record ruling, test and mutation result in docs/evidence/2026-09-24-item-i/LANE.md under "Fold 2".
Read AGENTS.md first.

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); no supabase, vercel, ssh; no swarm/cswarm against a real workspace; do not read
~/.cswarm or ~/.config/cswarm (tests use a temporary HOME). No server or migration change. Every test has a timeout.
Leave changes uncommitted; the lead commits.

RULINGS
G1 (Opus 3, PRODUCTION). `session enable`, `session disable` and `session recover` are HUMAN-ONLY commands (they
   take the human credential). Fold 1 added CREDENTIAL_FLAGS and host-session-id to their assertShape, so an agent's
   --profile or --agent-token-file is now accepted and ignored while the command acts with the stored human login.
   Restore the refusal: in AGENT_COMMANDS these three variants use REFUSE_PROFILE (the `start`, `status` and `stop`
   variants keep EXPAND_PROFILE_KEEP_HOST), their flag lists drop the agent credential flags, and runSession's
   enable/disable/recover assertShape is exactly as at 0260ab8d. The generated all-rows test derives its rows from the
   table, so these three drop out of it by construction. Tests: `session enable --profile P` is refused as a
   profile-refusing command and `session enable --agent-token-file F` fails with unknown option, both before any
   credential lookup (no human-credential read); the same for disable and recover. Mutation: re-adding
   CREDENTIAL_FLAGS to their assertShape fails the test.
G2 (Opus 4). The `resume` instruction for an UNBOUND profile is byte-identical to 0260ab8d: use
   profile.host_session_id ?? the receive binding's host_session_id. Test: unbound profile with a receive binding for
   session B prints --host-session-id 'session-B'; bound profile prints the bound id.
G3 (Opus 5). `listen start|status|stop|canary` and `session status|stop`: --host-session-id is accepted only together
   with --profile; without --profile it is refused with a usage error. Test per row, generated from the table where
   possible.
G4 (Opus 6). The setup wrapper keeps each error's class: add the operator step to the message of the SAME error object
   (or an instance of the same class), never wrap a typed error in a plain Error. Use the existing
   withSetupOperatorStep helper in src/onboarding-cli.ts. Test: a typed non-AgentSetupError failure from setup keeps its
   class and the CLI's class-based handling (non-JSON mode) still applies.

Report: each ruling -> change -> test -> mutation result; focused tests; what you did not establish.

===== OPUS REVIEW (round 2) =====
# Item I — Checker review (Claude Opus arm), round 2

Lane `lane/item-i` at `4cbe7d01` (fold 1 on `5fe61316`), base `0260ab8d`. I worked on a fresh `git archive 4cbe7d01`
under `scratchpad/itemI/opus-probes/r2` (built, exit 0) and a second archive, `mut2/`, for mutations and a
regenerated baseline. Every run used a temporary HOME and a loopback fake edge. No production host, no real
workspace, no other model CLI. No process is left running (`pgrep -f fake-edge` is empty).

Files (in the scratchpad, untracked): `harness2.mjs` (every `--profile` row × {B, no id, A}, with a fresh profile,
request counts, an fs/fetch trace, and a byte snapshot of the profile folder before and after each run),
`hookprobe2.sh` (the real `receive configure --provider claude` hook, run for two sessions and with the edge
down), `mutate.py` (13 mutations), and the results `r2-*-results.json`, `mut2-*.log`, `r2-tests.log`, `regen.log`.

## Findings

### 1. RIGOUR (blocks landing) — `command-table-gates` is red, and the new env sentence causes it

`tests/p1-cli/command-table-gates.test.ts:162` fails at 4cbe7d01 (it passed at 5fe61316 in round 1):
```
AssertionError [ERR_ASSERTION]: AGENT_QUICK_GUIDE names cswarm reads, which is absent from AGENT_COMMANDS
```
The cause is the F5 sentence in `src/cloud/agent-onboarding-contract.ts:44`:
`...; cswarm reads no environment variable for the session id.` The gate reads every `cswarm <word>` in the guide as a
command. The wording is true. It must be rephrased (for example "the CLI reads no environment variable for the
session id"), and the brief, LANE.md, and the item-I test that pin the exact words must change with it. This test is
under `test:p1-cli`. LANE.md "After-change local evidence" does not mention it.

### 2. RIGOUR (blocks landing) — `command-dispatch-baseline` is red: 22 rows were not recorded again

`tests/p1-cli/command-dispatch-baseline.test.ts` fails at 4cbe7d01. I recorded it again in the `mut2` copy
(`UPDATE_DISPATCH_BASELINE=1`, sources identical to r2) and compared the result with the committed fixture. 22 of
1261 rows changed:
- 12 `listen`/`session` rows (`listen.start|status|stop|canary`, `session.status|stop`, and the
  `policy.host-session.*.keep` copies). They were `unknown option: --host-session-id` and are now the handler's
  real result, for example `listen status` → `{"status":"not_found",...}` with exit 0. F2 intends this.
- 10 `setup` rows whose error now ends with the operator step. 8 of them are the argument error
  `"--connection-file is required Stop and tell the operator. Do not open another agent's profile."` (F9). There is
  also `policy.host-session.setup.keep`.
Each change follows a ruling, but the gate is red, and no one reviewed the 22 row changes. Note that a usage error
the agent can fix itself now says "Stop and tell the operator". F9 says "setup failures", and whether a missing flag
counts as one needs a ruling.

### 3. PRODUCTION — `session enable|disable|recover` now accept agent credentials and then ignore them

`src/cli.ts` `runSession` enable/disable/recover shape (fold diff at `@@ -7429`): `...CREDENTIAL_FLAGS` was added.
These are human-only commands (`humanCredential(args, cloud)`). Now, an agent's `--profile` expands to
`--agent-token-file …`, the shape passes, the agent token is dropped, and the command continues with the host's
stored human login. Measured (temporary HOME, so no human login exists):
```
                          base 0260ab8d                           r2 4cbe7d01
session enable --profile  cswarm: unknown option: --agent-token-file   cswarm: not logged in; run cswarm login
session enable --agent-token-file … (no profile)  unknown option: --agent-token-file   not logged in; run cswarm login
(disable and recover: the same, 3 of 3; bound profile with A: "not logged in" as well)
```
On a host where the operator is logged in (the fleet host), `cswarm session enable --profile <p> --principal-id X`
from an agent now runs as the operator. It changes managed-session enforcement ("Older clients lose mutation
access…"). At base the same command was refused. The brief also requires that an unbound profile behave exactly as
before, and here it does not.

The generated test forces this. M12 (remove `CREDENTIAL_FLAGS` from that shape) fails
`every table row that accepts --profile refuses B and parses A's id`. Correct fix: make these three rows
`REFUSE_PROFILE` (they never worked with `--profile`), or let the generated A check accept a typed "human-only"
refusal. Do not accept agent credential flags for them.

### 4. RIGOUR — unbound `resume` drops the session's id from its instruction

`src/onboarding-cli.ts:264` `instruction: turnCheckInstruction(path, profile.host_session_id)`. Take an unbound
profile that has a receive binding for session B, and run `resume --profile <p> --host-session-id session-B`:
```
base: ... run cswarm check --profile <P> --host-session-id 'session-B'. Read new messages ...
r2:   ... run cswarm check --profile <P>. Read new messages ...
```
Unbound output is no longer the same as at 0260ab8d. Fix: `profile.host_session_id ?? binding?.host_session_id`. The
M9 test covers only the bound case, so no test catches this.

### 5. RIGOUR (minor) — `listen` accepts `--host-session-id` and ignores it, even without `--profile`

`runListenStart`, `runListenStatusOrStop`, and `runListenCanary` accept the flag but never read it. At base,
`listen status --agent-token-file … --host-session-id X` was refused. Now it is accepted without effect, so a reader
could think the listener is bound to that session. Either refuse the flag when there is no `--profile`, or state that
it only passes through the profile check.

### 6. RIGOUR (minor) — the F9 wrapper removes the error's class

`src/onboarding-cli.ts` `runSetupImport` rethrows every non-`AgentSetupError` as `new Error(message + step,
{ cause })`. The `main().catch` class branches (`RenewalReauthorisationRequired|RenewalRevoked|RenewalSuspended`,
`WorkspaceCliError`, `src/cli.ts:9771-9781`) no longer see setup's errors in the non-JSON mode. JSON mode already
maps them all to `onboarding_failed`, so the effect is small. But the output now depends on a wrapper and not on the
class. That goes against the direction of D-053.

## Rulings F1–F10: re-measured

| Item | Measurement at 4cbe7d01 | Result |
|---|---|---|
| (1) F1 hook | `hookprobe2.sh`, real installed hook, bound to A, one project folder. B turn: exit 0, 0 requests, folder byte-identical, output empty. Turn with no stdin id: the same. A turn: 2 requests. With the edge down, A gets `CommonSwarm check failed (check_failed)… Run cswarm check --profile '<P>' --host-session-id 'session-A'`, and B's turns stay silent. The unbound sequence is identical to base. | PASS |
| (2) F2 rows | All 42 generated rows: bound A with A never ends in `unknown option`, `host_session_required`, or `profile_other_session`. `listen start` → `--provider is required`. `listen status/stop` → `not_found` JSON. `listen canary` reaches the edge. `session status/stop` → `--session-context is required`. `session start` → `--mode is required`. M5 (listen status refuses the flag) fails the generated test. M2 (a new row that skips the check) fails it. | PASS, but see finding 3 |
| (3) F3 | `receive configure` with no id → `host_session_required` with the brief's sentence. With `manual` → `profile_other_session`. M7 fails its test. | PASS |
| (4) F4 bound printed commands | resume/status/configure (turn and wake) `next_action` and `instruction`, the hook failure text, and the setup next_action all carry `--profile '<P>' --host-session-id 'session-A'`. SKILL.md, the guide, and the connect prompt show `--host-session-id <this-session-id>`. Unbound: identical to base except finding 4. | FAIL (finding 4) |
| (5) F6 | M3 (credential read before the check in `expandAgentProfile`) now fails `expand checks B before a damaged credential`. | PASS |
| (6) F8 | B on all 42 rows: the profile folder is byte-identical before and after, including `receive test` and `receive idle`. 0 edge requests, 0 `fetch`. The trace shows no read of the credential, cache, or receive state. M8 (lock before the check) fails its test. | PASS |
| (7) F7 / F9 | Setup with A → `host_session_bound: true`. With manual → `false`. Manual then A → `true`. Non-`AgentSetupError` failures end with the step (M10, a true revert, fails its test). | PASS (see 2 and 6) |
| (8) F10 MCP | `profile_other_session` → "stop and tell the operator". `host_session_required` → "restart this MCP server with the current host session". Pinned in both tests. M13 fails both. MCP startup prints `[profile_other_session]` / `[host_session_required]` with the brief's sentences. | PASS |
| (9) F5 claim | The narrowed sentence is the only live form (guide, connect prompt through `AGENT_SETUP_HOST_GUIDANCE`, brief lines 16 and 49, LANE.md). The retired words stay only in the dated corrections. The AST test has the `CLAUDE_CONFIG_DIR` positive control, and M11 (`process.env.CLAUDE_CODE_SESSION_ID`) fails it. The test would not see a dynamic `process.env[name]`, and there is none in `src/` today. The sentence breaks a gate (finding 1). | FAIL (finding 1) |

Mutations (each built and run against the item-I file, and against mcp-stdio for M13):
M1 comparison off → 7 tests fail. M2 bypass row → generated test fails. M3 credential first → F6 test fails.
M5 listen status refuses the flag → generated test fails. M6 F1 revert → hook test fails. M7 F3 revert → configure
test fails. M8 lock before the check → folder test fails. M9 resume revert → producer test fails. M10 F9 revert →
network-step test fails. M11 env read → AST test fails. M12 → the generated test fails, which confirms it forces
finding 3. M13 F10 revert → 2 tests fail. The sources were restored and compared with `diff -r` (identical).

## Tests

These 8 files together (item I, mcp-stdio, command-dispatch-baseline, command-table-gates, agent-connection-token,
permissions-default, agent-onboarding, and the site connect observer) give **97/99**. The 2 failures are findings
1 and 2. Both are in `test:p1-cli`. `npm run check:tests` exits 0. The item-I file gives 13/13. I did not run the full
`npm test` or `test:p1-cli`.

## Not established

- The production A/B/no-id request count.
- Live Claude Code or Codex hook stdin equality with `$CLAUDE_CODE_SESSION_ID` / `$CODEX_THREAD_ID`.
- The ids after `/clear` or resume.
- Whether a static MCP config can pass the id.
- The full suites.

VERDICT: FAIL
