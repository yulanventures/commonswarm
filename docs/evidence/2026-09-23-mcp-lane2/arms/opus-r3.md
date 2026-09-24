# Checker review, round 3 (Claude Opus arm): `lane/mcp-stdio` at `d7c17124`

- Range reviewed: `git diff 8321eae3..d7c17124`. That is Codex fold 2, `9e725974` (rulings F2-A to F2-D in `scratchpad/mcp/maker-fold2.txt`), plus the lead's `d7c17124`.
- I also re-checked the whole lane against the brief and my round-1 and round-2 findings.
- The worktree `scratchpad/arms-mcp` was confirmed at `d7c17124` and left unchanged.
- All measurements use a fresh `git archive d7c17124` copy at `scratchpad/mcp/opus-probes/srcd7c`, built with exit 0.
  - Probes: `srcd7c/probes/probe.test.ts` (P1 to P11) and `srcd7c/probes/codes.ts` (every post_signal edge code through `mapMcpError`).
  - Mutations: `opus-probes/mutate.sh` makes a fresh archive per mutant, applies one exact-anchor edit, rebuilds, runs `tests/p1-cli/mcp-stdio.test.ts`, and deletes the copy.
- I contacted only a loopback fake edge. I started no model CLI. No probe process remains.
- Baseline at `d7c17124`:
  - `mcp-stdio`, `signals`, `command-dispatch-baseline`, `signal-body` and `citation-drift` pass 53/53. `mcp-stdio` alone is 20 tests.
  - `bash scripts/build-release.sh` exits 0.
  - Driving the release bundle over stdio for P1, P4, P5, P9 and P11 passes 5/5.

## Items the coordinator asked me to check

### 1. Finding A: every code the command edge can return to post_signal

I enumerated every `error:` literal and dynamic error field in `supabase/functions/command/index.ts` and `_shared/*`. I kept the codes an agent's `post_signal` can reach: no attachments or thread keys, because the MCP schema cannot send them. I added the session-fence codes from `AGENT_SESSION_ERROR_CODE_LIST`, with statuses from `agentSessionErrorStatus`. Measured output of `probes/codes.ts`:

| HTTP | code | message | next_step | True? |
|---|---|---|---|---|
| 403 | forbidden | "A reply may target your own ask or an expired signal; a recipient may no longer be active; this agent's access may also have changed." | check the named arguments; if they are right, a person may need to restore this agent's access | **Yes, hedged.** The edge returns a bare 403 when `resolveSignalWriteTarget` is null (`index.ts:9666-9676`). Causes: the reference is missing, expired, not ask/note, or not addressed to the caller (`8475-8504`), or the target is no longer live (`8505-8528`). Plus the scope gate. The sentence names three causes and allows for the rest. |
| 400 | invalid_request | "The service did not accept the named arguments." | fix the named argument | Yes |
| 409 | command_id_conflict | "This request id was used for different arguments." | stop and keep the same request id | Yes |
| 429 | rate_limited | "The signal rate limit was reached." | retry the same call | True eventually, but see note N1 |
| 401 | unauthenticated | "The service refused this agent's credential." | a person must restore this agent's access outside this session | Yes |
| 426 | upgrade_required | "This client must be upgraded before access can resume." | a person must restore … | Yes (a person must update the client) |
| 413 | payload_too_large | "The body or about argument is too large." | fix the named argument | Yes. It cannot be reached from MCP: the edge cap is `MAX_BODY_BYTES` 128 KiB (`index.ts:633`), and the largest MCP body is about 48 KB. |
| 404 | channel_not_found | "The channel argument names no channel in this workspace." | fix the named argument | Yes |
| 409 | channel_archived | "The channel argument names an archived channel." | fix the named argument | Yes |
| 500 | internal_error | not mapped: a 5xx returns `{outcome:"unknown"}` (`server.ts:121-122`) | n/a | Yes |
| 401/403/409 | session_proof_missing, session_proof_invalid, session_expired, session_retired, session_conflict (and the other session-fence codes) | "The service returned session_expired with status 401." (fallback) | check the arguments; if the problem stays, ask a person | Neutral fallback as ruled. See note N2. |

- **P9** (reply, edge 403 `forbidden`) now returns the hedged sentence and step, on both the build and the release bundle.
- The lane's own stdio test (`mcp-stdio.test.ts`, "edge refusal codes give exact post and read next steps") checks the full payload for each of these codes. For `forbidden` it covers all four post tools.
- **Mutation:** changing the `forbidden` step back to PERSON makes that test fail (1 fails / 19 pass).

### 2. The read path: 401, 403 and 426 still say a person must restore access

`errors.ts:122` now checks the status before the envelope code. So read 401, 403 and 426 always give `read_refused` / "The service refused this read." / PERSON, with the status. The lane test asserts this for all three statuses. As a side effect, a read `forbidden` can no longer pick up the post-path hedged sentence.

### 3. The cap: M4a and the largest-check bound

| Mutation | Result |
|---|---|
| M4a: commit the full cursor after a partial, capped page | **Now fails** "MCP partial check commits only the last visible message" (1 fails / 19 pass) |
| M4c: commit the full cursor when zero messages are visible | Fails "MCP fresh check cap leaves unseen messages eligible" |
| Mbound: `MCP_RESULT_MAX_BYTES` lowered to 16 KiB | Fails 2 tests, including the largest-check assertion |

- The largest-check assertion now checks that the last message id is visible, not only the byte size, so it can fail.
- **P11** (a stateful fake edge with a 30 KB workspace name) shows ids 00–03, then 04–05, then empty. Every message was seen exactly once, on both the build and the release bundle.

### 4. Renewal codes and the generated coverage test

- `predecessor_superseded` is now "retry the same call". `successor_not_recoverable` asks a person. The `RenewalRefused` successor-shape codes are "retry the same call".
- A bare renewal `forbidden` is mapped by class to `renewal_forbidden` (PERSON), so it cannot pick up the post-path hedged sentence.
- The coverage test now derives its code lists from real sources, not a typed file list:
  - `AgentSetupError` literals in `server.ts` and every module it imports (via the test tsconfig program);
  - the exported `RenewalRejectionReason` union and `REVOCATION_REASONS_LIST`;
  - the `RenewalRevoked` and `RenewalRefused` constructor literals in `renewal.ts`;
  - every `SessionContextErrorCode`.
- One limit: it follows only `server.ts`'s direct imports. I checked by hand that none of the 38 `AgentSetupError` codes missing from the table is thrown in a module on a tool path; all are in setup, onboarding, hook, receive or grok-bot modules.
- **Mutation M7** (put producer-message pass-through back) fails 8/20.

### 5. The CLI `--to` accepts every name it accepted at origin/main

`git diff adef94b4 d7c17124 -- src/cloud/signals.ts` shows only three changes:
- the new `SignalRecipientError` class;
- the four existing `throw new Error(...)` calls became `throw new SignalRecipientError(code, <the same message text>)`;
- the 80-character bound is removed from the shared resolver.

So the CLI resolver accepts the same inputs and prints the same messages as main. The `recipient_invalid` member of the code union is now unused. The new test resolves a 256-character name and keeps the old "not a live member" sentence for `""`. The 80-character cap is now only in the MCP schema, and its comment names the unbounded `text` columns.

### 6. Channel enforcement matches the advertised pattern

- `validateMcpArguments` no longer normalises. It tests the raw value against the advertised `CHANNEL_SLUG_RE.source`, with `maxLength` `CHANNEL_SLUG_MAX`, and uses no `"i"` flag.
- `TEAM-UPDATES`, `" team-updates"` and `"team-updates "` each give `-32602` (lane test). The tool descriptions say slugs are lowercase.
- The only extra rule is `channelSlugProblem`'s reserved name `all-signals`. It matches the pattern but is refused, so enforcement is stricter than advertised by one name. That direction is safe.

### 7. Earlier fixes still hold (mutations re-run on `d7c17124`)

| Mutation | Fails |
|---|---|
| M1: commit before the write | "deferred commit occurs only after a successful write" |
| M2: start-up stdout banner | 3 tests, including stdout purity and managed start |
| M3: drop the forward-only cursor compare | "deferred cursor merge preserves a later check and cache rows" |
| M6: `unknown` only for transport errors and 5xx | "malformed accepted response is unknown" |
| M7: producer-message pass-through | 8 tests |

Probe re-runs:
- P3 and P8: no shell text reaches the model.
- P4: an accepted but malformed reply gives `unknown`.
- P5: cancel sends nothing on the wire, and the same-id retry reaches the edge with the same `command_id` (`["probe0005","probe0005"]`, created 1).
- P7: stdout stays JSON-only; the renewal warning goes to stderr.
- P1: post results have five keys.
- P2 now stops at the schema: `until:"45s"` gives `-32602`, which is intended.

The d7c17124 lead change:
- An unknown argument name is echoed JSON-quoted and cut to 64 characters (`tools.ts:47`); a unit test covers it.
- LANE.md R10 now says correctly that the `["mcp","extra"]` policy and selected-error rows record only the error mode.

## Non-blocking notes

- **N1 (rate_limited).** The edge refuses at 120 signals per credential per hour (`index.ts:652`). Each refused request also inserts a `swarm.security_alerts` row (`index.ts:9723-9735`), and the 429 body carries `resets_at`. The step "retry the same call" gives no time. A model that follows it at once gets refused again, and each retry adds another alert row. Suggestion: pass `resets_at` (a server value, not prose) and say "retry the same call after resets_at".
- **N2 (session fence codes).** A managed seat (`--host-session-id`) whose host session expired or was retired gets `session_expired`, `session_proof_invalid`, `session_retired` or `session_conflict` from the edge. The model then sees the neutral fallback "check the arguments; if the problem stays, ask a person". That is not false, but the arguments are never the cause. `AGENT_SESSION_ERROR_CODE_LIST` is exported, so these could map to a PERSON-style sentence: restart the MCP server with the current host session.
- **N3.** The `forbidden` sentence gives examples, not the full cause list. It does not name "a signal not addressed to this agent" in general, nor a wrong or non-ask/note `signal_id`. The next step still sends the model to check the named arguments.
- **N4.** LANE.md's original decision-6 row still says "cancellation after send start puts unknown on the stdio wire" (line 14). The Fold 1 section says it supersedes that row, and keeping retired wording follows the repo rule. An inline "(retired, see Fold 1)" marker would help readers.

## Not established

- The live Done-for-release-1 items: production controls per tool, Claude Code and Codex transcripts, and npm.
- A real second process running the hook `cswarm check` against the MCP commit. The forward-only merge is proven by the lane's simulated interleaving and by mutation M3.
- I did not re-run the full `npm test` and `test:p1-cli`. LANE Fold 2 reports 960/962 and 871/874; the failures are the sandbox `ps` EPERM tests.

## Ruling

- Round-2 blocking finding A is fixed. Every real post_signal edge code now gets a true or hedged sentence and next step, and a test discriminates the change.
- Findings B, C and D are fixed, each with a mutation-proven control.
- All earlier fixes still hold under their mutations, on both the build and the shipped bundle.
- The remaining notes are refinements, not false claims.

VERDICT: PASS
