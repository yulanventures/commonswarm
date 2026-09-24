# Item I — Checker review (Claude Opus arm), round 3

Lane `lane/item-i` at `2dbbfe23`: 4a306478 (lead), cd2fd324 (fold 2, G1–G4) and 2dbbfe23 (lead, baseline) on top of
round 2's `4cbe7d01`. Base `0260ab8d`. I worked on fresh `git archive 2dbbfe23` copies: `opus-probes/r3` for probes
and `opus-probes/mut3` for mutations and baseline regeneration. Both built with exit 0. Every run used a temporary
HOME. No process is left running.

**Hard-rule incident (read this first).** In the G1 matrix, my positive control was
`cswarm session enable --principal-id <uuid>` with no `--url`. Its purpose was to show what a command that is not
refused reaches. Because it had no target flags, the CLI ran its own target discovery and printed
"Using the CommonSwarm deployment at https://api.commonswarm.com, discovered from https://commonswarm.com and saved."
So at least one unauthenticated request went to the public site `https://commonswarm.com`. The temporary HOME held no
human login and no credential, so nothing was authenticated or sent in a body. The next controls stopped at
"not logged in". I deleted the temporary HOME. I cannot tell whether `api.commonswarm.com` was also contacted. Every
other probe in this round and in earlier rounds used `--url http://127.0.0.1:<port>` or a profile that points at
loopback. This target discovery was already in the CLI before this lane; the lane did not add it.

## Findings

### 1. RIGOUR (minor, does not block) — the `session enable|disable|recover --profile` refusal names `session` as supported

For `cswarm session enable --profile … --principal-id …` the output is:
`cswarm: --profile is supported by: whoami, resume, working-on, note, ask, reply, receipt, feed, inbox, brain, file,
members, feedback, listen, session, channel.`
The list is generated (`AGENT_PROFILE_COMMANDS`, `src/cli.ts:9575`), but per verb: a group is listed when it has
`profileListOrder`. After G1, `session start|status|stop` accept `--profile` and `enable|disable|recover` do not.
So the refusal of `session enable` names `session` as supported. The sentence is true for the verb but misleads for
this command. A refusal that names subcommands (for example `session start|status|stop`) would be exact. The list
also leaves out `check`, `setup`, `receive` and `mcp`, which accept `--profile` natively. That was already true at
0260ab8d.

### 2. RIGOUR (minor, does not block) — `session status|stop` accept `--workspace-id` and ignore it when there is no `--profile`

Fold 1 added `workspace-id` to these shapes so that the `--profile` expansion would parse. G3 now refuses
`--host-session-id` without `--profile`, but `--workspace-id` has no such guard. Measured:
`session status --agent-token-file … --url … --anon-key … --workspace-id W`:
- base: `unknown option: --workspace-id`
- r3: `--session-context is required`

So a legacy caller's `--workspace-id` is now accepted and then ignored. `requireProfileWithHostSessionId` could
cover it in the same way.

(An observation that is not a finding: G4 assigns `error.message` on the caught error. For an error whose `message`
has only a getter, such as `DOMException`, that assignment throws a `TypeError` in strict mode. I measured this in
Node 26. I could not make it happen through setup: a `DOMException` thrown by `fetch` is converted to "member read
could not reach the cloud service" before it gets there. That was measured on base, r2 and r3.)

## The questions you asked, measured

| Question | Measurement | Result |
|---|---|---|
| M12 / finding 3 probe: no path lets `--profile` or `--agent-token-file` reach enable/disable/recover or the stored human login | 7 forms × 3 commands, with an fs trace under HOME. The forms: `--profile` (unbound), `--profile` bound + A, `--profile` before the verb, `--agent-token-file`, `--agent-token-stdin`, `--host-session-id`, and a plain call. Every agent form gives `--profile is supported by: …` or `unknown option: --agent-token-file` / `--agent-token-stdin` / `--host-session-id`, with **no file reads** under HOME. The plain call reaches the human login lookup (`~/.cswarm/credentials.d/…`, "not logged in"), which shows the trace can see that lookup. Table: the three rows are `profile: "refuse"` with no `profile` or `agent-token-file` flag. | PASS |
| Refusal text true? | Generated per verb, so it names `session` (finding 1). | Partly true (finding 1) |
| resume unbound identical to 0260ab8d | Unbound profile, byte comparison of base against r3 in 6 cases: no receive binding and a binding for session B, each with no id, `session-B` and `session-C`. All 6 are identical. Bound profile + A → instruction carries `--host-session-id 'session-A'`. | PASS |
| G3 per row | `listen start|status|stop|canary` and `session status|stop` with `--host-session-id` and no `--profile` (flag before or after the verb): r3 → `--host-session-id requires --profile for this command`. With `--profile` (unbound, or bound + A) the flag is accepted and the handler runs. `session start` keeps its own required id. Legacy calls without the flag are unchanged, except finding 2. | PASS |
| G4 class kept in non-JSON mode | Setup with a fetch preload that returns `renewal_horizon_reached`. base plain: the `RenewalReauthorisationRequired` paragraph with no `cswarm:` prefix. r2 plain: `cswarm: CommonSwarm stopped renewing…` (class lost). r3 plain: the paragraph with no prefix, as at base, and it ends with the operator step. JSON mode gives `onboarding_failed` in all three. | PASS |
| Normalizer hides only run-dependent values | The new rules match only `"profile_id": "<24 hex>"` and `/state/<64 hex>`. In the fixture they now hit only the 4 `listen.status|stop` rows (both copies). At 4cbe7d01 there were 0 literal matches, so no pinned value is hidden. `profile_id` and the state key are functions of the target origin: ports 41001, 41002 and 41001 again gave `c3d141…`, `9e27df…` and `c3d141…`. The fixture server's port changes per run, so the values do too. `principal_id` and `workspace_id` stay pinned. I regenerated the baseline in `mut3` (`UPDATE_DISPATCH_BASELINE=1`), and it is **byte-identical** to the committed fixture and counts. | PASS |
| Full item-I sequence | **Rows:** 39 generated rows (42 minus the 3 human-only rows). B: 39/39 give the other-session sentence, 0 edge requests, 0 `fetch`, no credential/cache/receive read, and a byte-identical folder. No id: `host_session_required` except where the parser needs the id (`receive test|confirm|idle|serve`) and `setup` (`setup_host_session_required`). A: past parsing and the check on every row, and 22 rows reach the edge. Unbound, compared with base: identical, apart from the intended setup change and the intended acceptance of the id with `--profile` on listen/session. **Hook (two sessions, real installed hook):** B turns and turns with no stdin id are silent, send 0 requests and leave the folder byte-identical. A turns work, and with the edge down A reports the real failure with `--host-session-id 'session-A'`. Unbound hook output is identical to base. | PASS |

## Mutations (19, each built and run against the item-I file; M13 also against mcp-stdio)

Each mutation fails at least one test. The tests it fails:
- M1 comparison off → 7 tests.
- M2 new row that skips the check → generated test.
- M3 credential read before the check → the expand test.
- M5 `listen status` refuses the flag → generated test and the G3 test.
- M6 F1 revert → hook test.
- M7 F3 revert → configure test.
- M8 lock before the check → folder test.
- M9 resume uses the binding only → producer test and resume test.
- **N3 G2 revert** (profile only) → resume test.
- M10 F9 revert → network-step test and typed test.
- **N5 G4 revert** (plain `Error` wrap) → typed-renewal test.
- M11 env read → AST test.
- M13 F10 revert → 2 tests.
- **N1 re-add `CREDENTIAL_FLAGS` and the id to enable/disable/recover** (the old M12) → human-lifecycle test.
- **N2 the human-only rows back to EXPAND** → generated test and human-lifecycle test.
- **N2b the agent flag list back on the human-only rows** → human-lifecycle test.
- **N4 G3 guard off** → G3 test.
- **N6 argument errors back inside the setup try** → argument-error test.

I restored the sources and compared them with `diff -r` (identical).

## Tests

These 9 files together give **105/105**: item I, mcp-stdio, command-dispatch-baseline, command-table-gates,
citation-drift, agent-connection-token, permissions-default, agent-onboarding and the site connect observer. The
two gates that were red in round 2 now pass. `npm run check:tests` exits 0. I did not run the full `npm test` or
`test:p1-cli`.

## Not established

- The production A/B/no-id request count (the lead owns it).
- Live Claude Code or Codex hook stdin equality with `$CLAUDE_CODE_SESSION_ID` / `$CODEX_THREAD_ID`.
- The ids after `/clear` or resume.
- Whether a static MCP config can pass the id.
- The full suites.
- Whether `api.commonswarm.com` was reached by the incident above.

VERDICT: PASS
