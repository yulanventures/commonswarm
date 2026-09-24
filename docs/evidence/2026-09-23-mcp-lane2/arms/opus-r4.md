# Checker review, round 4 (Claude Opus arm): `lane/mcp-stdio` at `c32abeb5`

## Scope and method

- **Range reviewed:** `git diff d7c17124..c32abeb5`, which is Codex fold 4 with rulings F4-1 to F4-6 in `scratchpad/mcp/maker-fold4.txt`. I also re-read the whole of `src/mcp/errors.ts`.
- **Worktree:** `scratchpad/arms-mcp` is at `c32abeb5`. I did not change it.
- **Copy under test:** all measurements use a fresh `git archive c32abeb5` copy at `scratchpad/mcp/opus-probes/srcc32` (build exit 0).
  - Probes: `srcc32/probes/probe.test.ts` (P1–P11) and `srcc32/probes/codes.ts`. The second one runs every post_signal edge code and every `AGENT_SESSION_ERROR_CODE_LIST` code through `mapMcpError`.
  - Mutations: `opus-probes/mutate.sh`. It makes a fresh archive per mutant, applies one exact-anchor edit, rebuilds, and runs `tests/p1-cli/mcp-stdio.test.ts`.
- **Safety:** I contacted only a loopback fake edge. I started no model CLI. No process of mine remains.
- **Baseline at `c32abeb5`:** `mcp-stdio`, `signals`, `command-dispatch-baseline`, `signal-body` and `citation-drift` pass 53/53. `mcp-stdio` alone is 20/20.

**A correction to my round 3:** I accepted "A reply may target your own ask or an expired signal; …" as a hedged list of causes. Read as a model reads it, "may target" grants a permission. That is the opposite of the edge rule. Grok's round-3 FAIL on this was right, and I missed it.

## Rulings: fixed, and the revert fails a test (measured)

| Ruling | Fixed in code | Mutation (fresh archive) | Result |
|---|---|---|---|
| F4-1 `forbidden` states causes | `errors.ts:59`: "The service refused this post. Possible causes: a reply to your own ask; a reply to a signal that has expired or is not addressed to this agent; a recipient that is no longer active; a change to this agent's access." P9 returns exactly this sentence. | Put the old permission-shaped sentence back | fails "edge refusal codes give exact post and read next steps" (1 fails / 19 pass) |
| F4-2 session codes | `AGENT_SESSION_PROOF_REFUSAL_CODES` (`session-wire.ts:44-49`) is spread into the table with "restart this MCP server with the current host session". Read path: `errors.ts:127` checks these codes before the 401/403/426 branch. | Drop the first session code from the spread | fails the coverage test and the edge-codes test (2 fail) |
| F4-3 rate limit | New sentence, plus the step "wait, then retry the same call with the same request_id". No `retry_after`: the client does not parse `resets_at`, as the ruling allows. | (LANE records its own revert) | pinned by the exact-payload test |
| F4-4 channel not-enum | The schema advertises `not: { enum: RESERVED_CHANNEL_SLUGS }` (`tools.ts:23`). `validateMcpArguments` enforces pattern + maxLength + `not.enum` and has no second classifier (`tools.ts:49-52`). | Remove `not` from the schema | fails "schemas reject invalid durations and use shared request and channel rules" |
| | | Keep the schema, drop the `not.enum` check | fails the same test (`all-signals` is accepted) |
| F4-5 partial page | The library now returns all six rows. The test asserts this before the cap. | `capFreshCheck` never drops rows (`<= Infinity`) | fails "partial check commits only the last visible message" and "fresh check cap leaves unseen messages eligible" (2 fail) |
| | | M4a: full cursor committed after a partial page | still fails "partial check commits only the last visible message" |
| F4-6 LANE record | Row 6 keeps "cancellation after send start puts unknown on the stdio wire" in quotes with "(superseded by Fold 1: …)". R9 now says there is no normalisation and the 80-character bound is MCP-schema only. The R10 comment is added. | (document assertion) | pinned by the fold-corrections test |

Probes still hold on `c32abeb5`:

| Probe | Result |
|---|---|
| P1 | Post results have five keys; the retry after a 403 reaches the edge. |
| P3 | Renewal horizon and suspension give table sentences with no `cswarm`. |
| P4 | A malformed accepted reply gives `unknown`. |
| P5 | Cancel sends 0 wire lines. The same-id retry reaches the edge with `command_ids ["probe0005","probe0005"]`, created 1. |
| P7 | stdout is JSON only; the renewal warning goes to stderr. |
| P8 | check_timeout gives a table sentence. |
| P10 | A bare 400 gives `unknown`. |
| P11 | ids 00–03, then 04–05, then empty: every message seen exactly once. |
| P2 | Stops at the schema (`until:"45s"` → `-32602`), as intended. |

## Claims review: every model-visible sentence in `src/mcp/errors.ts`, read as a model reads it

I compared each sentence and next step with the code that produces its code. Session fence: `supabase/functions/_shared/agent-auth.ts:200-290`. Rate limit: `command/index.ts:5226-5262`, `5100-5116`, `9704-9744`. Reply target: `command/index.ts:8415-8528`, `9660-9676`.

### Finding R4-1 (PRODUCTION, claim): the `rate_limited` sentence names the wrong cause for the workspace bucket

`src/mcp/errors.ts:65`
```ts
rate_limited: entry("The signal rate limit for this agent was reached; it resets within an hour.", WAIT_AND_RETRY),
```
- The edge has two buckets, and both return the same `429 {error:"rate_limited"}`:
  - `signal:credential:<kind>:<credentialId>` at 120 per hour;
  - `signal:workspace:<workspaceId>` at **1000 per hour, shared by every member and agent in the workspace** (`command/index.ts:652-653, 5237-5261`).
- When the workspace bucket trips, "The signal rate limit **for this agent** was reached" is false. The agent may have posted nothing this hour.
- On a busy workspace this is reachable. The hub runs about 20 seats, so 1000 per hour is about 50 per seat.
- LANE Fold 4 F4-3 repeats the claim: "names this agent's hourly limit".
- The next step (wait, then retry with the same `request_id`) is correct for both buckets.
- "Resets within an hour" is true: the window is `date_trunc('hour')`, and `resets_at = window_start + 1 hour`.
- **Fix:** one clause, e.g. "The signal rate limit for this agent or its workspace was reached; it resets within an hour."
- Also update the pinned test string and the LANE F4-3 wording.
- The lead's ruling prescribed this exact sentence, so the lead must rule on the change.

### Every other sentence (accepted, with notes)

| Code(s) | Sentence / step | Checked against the edge or client |
|---|---|---|
| `forbidden` (post) | causes list / CHECK_ACCESS | `resolveSignalWriteTarget` is null when:<br>• the reference is missing, not ask/note, or expired (`8475-8481`);<br>• the reference is not addressed to the caller by scalar or recipient set (`8483-8504`), which includes a reply to your own ask;<br>• the target is not live (`8505-8528`).<br>The scope gate covers "a change to this agent's access". "Possible causes" is a non-exhaustive list: a non-existent or `working-on` `signal_id` is not named, but "check the named arguments" covers it. **True.** |
| `session_proof_missing`, `session_proof_invalid`, `session_expired`, `session_conflict` | "The current host session was refused by the service." / restart with the current host session | The edge's `enforceAgentSessionProof` `refuse(...)` set is exactly these four (`agent-auth.ts:231-276`, and `290` for missing), with statuses 401/401/401/409 from `agentSessionErrorStatus`. Remedy is true. Wording is loose for `session_proof_missing`, where no session was presented. Acceptable. |
| other `AGENT_SESSION_ERROR_CODE_LIST` codes | fallback / CHECK_ARGUMENTS | These are not returned to post_signal or the reads (session-management commands only). Neutral. **OK.** |
| `channel_not_found`, `channel_archived` | name `channel` / FIX | `command/index.ts:8131-8149`. **True.** |
| `invalid_request` | "did not accept the named arguments" / FIX | Envelope and shape refusals. **True.** It names no argument, which is vague but not false. |
| `payload_too_large` | body or about too large / FIX | 413 when the request exceeds `MAX_BODY_BYTES` 128 KiB (`:633`). Not reachable from MCP (largest body about 48 KB), but true if it is. |
| `command_id_conflict` | STOP | 409 on hash mismatch (`:9400-9404`). **True.** |
| `unauthenticated`, `upgrade_required` | PERSON | **True.** |
| read 401/403/426 → `read_refused` | PERSON | **True.** The read-path mapping of session codes (`errors.ts:127`) is unreachable against the current read edge: only `command`, `activity` and `h0` call the session fence. It is harmless. |
| renewal table (`horizon_reached` … `malformed_wake`) | PERSON / RETRY | The RETRY codes (`predecessor_superseded`, `predecessor_pending_first_use`, `renewal_outcome_unknown`, the successor-shape codes) surface in one-shot mode only once the token has expired. At that point the next renewal gets a server verdict. **Not false.** |
| `profile_path_invalid`, `profile_symlink`, `profile_inside_repository` | FIX "fix the named argument" | The profile is a process flag, not a tool argument, so no argument can be fixed. Reachable per call only if the profile path changes while the server runs (`privatePath` runs on each check). Low reach. Note N-a. |
| `message_not_cached` | FIX | The id may be right but evicted. The tool description says only cached ids work. Note N-b. |
| `signal_refused` | PERSON | Not an edge code. Only the lane's fake edge uses it (`mcp-stdio.test.ts` fixture). A dead entry, harmless. Note N-c. |
| fallback | "The service returned X with status N." / CHECK_ARGUMENTS (4xx), RETRY (5xx) | **Neutral.** |

## Rigour notes

- **N-d:** the session coverage is circular. The test checks that the table has every code in `AGENT_SESSION_PROOF_REFUSAL_CODES`, but the table is built from that same constant, and `length === 4` is a typed number. A new `refuse("session_x")` in `agent-auth.ts` would not fail it. I checked by hand that the edge's set today is exactly those four. An independent control would read the `refuse(...)` literals from `supabase/functions/_shared/agent-auth.ts`.
- **N-e:** `until` and `body` still carry a rule beyond the advertised schema. `until` is limited to 30 days by `signalDuration` (so `31d` matches the pattern but gets `-32602`), and a whitespace-only body is refused. Both are stricter than advertised, which is the safe direction.

## Not established

- The live Done-for-release-1 items: production controls, the Claude Code and Codex transcripts, and npm.
- I did not re-run the full `npm test` or `test:p1-cli`. LANE Fold 4 reports 960/962 and 872/875; the failures are sandbox `ps` EPERM.

## Ruling

- Fold 4 fixes each ruling. Every mutation that matters now fails a test: the forbidden sentence, the session coverage, the channel not-enum on both sides, and the partial-page cap removal. My probes still hold.
- The claims review finds one model-visible false clause: R4-1, "for this agent" when the shared workspace bucket trips. The fix is one clause.

VERDICT: FAIL
