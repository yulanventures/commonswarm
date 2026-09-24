# Checker review, round 2 (Claude Opus arm): `lane/mcp-stdio` at `8321eae3`

- Range reviewed: `git diff 064a1cdd..8321eae3` (commits f8f2dec0, 1b1a07de, bd48fb6d, 3ad4e676, 8321eae3), together with the whole lane.
- Rulings: `scratchpad/mcp/maker-fold1.txt`. The three words the heredoc dropped are read as the lead stated: remove `replayed`, bound `to`.
- Worktree `scratchpad/arms-mcp` confirmed at `8321eae3`. I did not change it.
- All measurements use a fresh `git archive 8321eae3` copy at `scratchpad/mcp/opus-probes/src832` (built, exit 0). Probes are in `src832/probes/probe.test.ts` (P1–P11) and `src832/probes/codes.ts`.
- Mutations ran through `opus-probes/mutate.sh`. Each one uses a fresh archive copy, applies one exact-anchor edit, rebuilds, runs `tests/p1-cli/mcp-stdio.test.ts`, then deletes the copy.
- I contacted only a loopback fake edge. I started no model CLI. No probe process is still running.
- Baseline at `8321eae3`: `mcp-stdio.test.ts` passes 17/17. `signals`, `agent-seat-registration`, `command-dispatch-baseline`, `signal-body` and `citation-drift` pass 39/39.

## Round-1 findings, one by one

| # | Round-1 finding | Fixed in code? | Test fails when the fix is reverted? (measured) |
|---|---|---|---|
| 1 | Shell text reaches the model | **Yes** for every class I drove. P3: horizon gives "This agent reached its renewal horizon.", suspended gives "This agent's renewal is suspended.". P8: check_timeout gives "The message check timed out; the inbox state is unknown.". The release bundle gives the same result. `src/mcp/errors.ts:87-117` never copies producer prose. | **Yes.** M7 (pass `error.message` through again) fails 7/17. |
| 2 | Unclassified errors collapse to a generic sentence | **Mostly.** P2: unknown `to` gives `recipient_unknown` / "fix the named argument". Read refusals are classified through `followHttpDetails` / `followErrorEnvelope` (the Grok point is closed). **Wrong next_step for real edge codes: see new finding A.** | Yes, for the recipient and read-refusal paths (lane test, `mcp-stdio.test.ts:330-374`). |
| 3 | A committed write reported as failure | **Yes.** P4: `min_version` and `no_signal` both give `{"outcome":"unknown",…}` after the edge committed 1. `server.ts:116-124` makes only a typed 4xx with a code definitive. P10: a bare 400 with no code gives `unknown`. That is safe, because the retry replays or repeats the same refusal. | **Yes.** M6 (unknown only for transport/5xx) fails "malformed accepted response is unknown". |
| 4 | `replayed` is a false claim | **Yes.** `seenRequests`, the local conflict check and `replayed` are gone. P1: the result has 5 keys, and the retry after a 403 reaches the edge. | Yes (LANE R3 mutation; lane test checks the key list). |
| 5 | Unsolicited response after cancel | **Yes.** P5 (SDK client, lane build and release bundle): 0 wire lines for the cancelled id, `client.onerror` is empty, and the same-id retry reaches the edge with `command_ids ["probe0005","probe0005"]`, created 1. | Yes (lane test `:299-328` asserts no result or error on the recorded cancelled id). |
| 6 | The cap could advance past unseen messages | **Yes.** `capFreshCheck` (`tools.ts:95-103`) keeps the largest prefix that fits and commits only to the last visible id. Zero visible commits nothing. P11 (stateful fake edge, 30 KB workspace name): check 0 returned ids 00–03 with `has_more:true`, check 1 returned 04–05, and every message was seen exactly once. | **Partly. See finding B.** M4c (zero-visible still commits the full cursor) fails 1/17. **M4a (a partial prefix commits the full cursor) passes 17/17.** |
| 7 | Deferred commit: order, stale snapshot, leak | **Yes.** `agent-check.ts:228-237` re-reads under the lock and moves the cursor forward only. `sendWithDeferredCommit` (`server.ts:19-29`) commits after `rawSend` and deletes the entry in `finally`. Entries are deleted on abort (`:95`) and on error (`:129`). | **Yes.** M1 (commit before write) fails "deferred commit occurs only after a successful write". M3 (drop the forward-only compare) fails "deferred cursor merge preserves a later check and cache rows". |
| 8 | Start-up stdout not captured | **Yes.** Capture starts at `transport.start`, before connect (`mcp-stdio.test.ts:113-114`). | **Yes.** M2 (banner before `serveMcp`) fails 3/17, including the stdout-purity and managed-start tests. |
| 9 | Static SDK import cost | **Yes.** Dynamic import inside the handler (`cli.ts:9378`). `dist/cli.js --version`, 20 runs × 3: adef94b4 80.4 / 83.5 / 81.4 ms, 8321eae3 87.1 / 86.2 / 81.4 ms (noise). Release bundle: main 69.1 / 57.2 ms, lane 67.3 / 58.4 ms. The bundle (`build-release.sh` exit 0) was driven over stdio for P1/P3/P4/P5/P8/P9: 6/6 pass. So the lazily bundled server loads in the shipped artifact, not only for `--help`. | Yes (AST test `:543-557`). I did not re-mutate it; the static-import assertion is direct. |
| 10 | Typed or missing schema limits | **Yes.** Request-id bounds come from `H0_REQUEST_ID_MIN/MAX`. `signalDuration` moved to `src/cloud/signal-duration.ts`, the CLI and MCP share it, and a bad `until` is `-32602`. The channel uses `CHANNEL_SLUG_MAX/RE` and `normalizeChannelSlug`. `to` is bounded by `SIGNAL_RECIPIENT_MAX`. There is no `"i"` flag, and the uuid pattern advertises `[89abAB]`. | Yes (schema test `:524-541`). Minor: see finding D. |
| 11 | Baseline rows never reach mcp policy | **Yes.** Three new rows reach policy (`mcp.missing-profile`, `mcp.unreadable-profile` gives `profile_missing`, `mcp.manual-host-session` gives `host_session_invalid`). Measured: 1258 → 1261 rows, 0 existing rows changed from 064a1cdd, and 0 residual from adef94b4 after removing the one help line. | Yes (`:559-575`). |
| 12 | next_step and status | **Partly.** `status` appears only when ≥ 400. A renewal domain refusal carried by HTTP 200 has no status (P3, lane test `:416-434`). Per-code next_step: **see finding A**. Managed detection is local only, and LANE says so under "Not established". | Yes, for status. |
| 13 | Wrapper parity | Unchanged and acceptable. The reply-refusal hint is the gap. It is now finding A. | n/a |
| 14 | Cached view drops the trust label | **Yes** (`tools.ts:71-74`). | Yes (LANE R12). |

## New findings in round 2

### A. PRODUCTION: real edge refusals tell the model "a person must restore this agent's access"

`src/mcp/errors.ts:52` maps `forbidden` to "The service refused this agent's access." with next_step PERSON. `errors.ts:113-114` gives every code not in the table next_step PERSON when the status is below 500.

The command edge sends a bare `403 {error:"forbidden"}` for post_signal whenever `resolveSignalWriteTarget` returns null (`supabase/functions/command/index.ts:9660-9676`, audit reason "signal target or reply is not eligible"). That covers:
- a reply to a signal not addressed to the caller. The CLI's comment says the most common case is replying to your own ask (`src/cli.ts:3905-3928`);
- a reply to an expired signal (`index.ts:8475-8481`, `until > statement_timestamp()`);
- an ask or reply whose recipient is no longer live (`index.ts:8505-8528`).

None of these is an access problem. The CLI deliberately hedges this 403 (`replyRefusalHint`). Ruling R1 names "the reply refusal" explicitly. **P9 measured**, and it is the same through the release bundle:
`{"code":"forbidden","message":"The service refused this agent's access.","next_step":"a person must restore this agent's access outside this session","status":403}`.

Real 4xx codes that the model's own `channel` argument can trigger fall to the fallback with the same false next step (**measured**, `probes/codes.ts`):
- `404 channel_not_found`: "The service returned channel_not_found with status 404." / "a person must restore this agent's access outside this session".
- `409 channel_archived`: same.
- `400 invalid_request`: same.

The correct action is "fix the named argument" (channel) or "stop". A model told a person must restore its access will stop working, although it made a correctable mistake. The ruling asked for next_step "per code and truthful".

Suggested fix:
- give `channel_not_found` and `channel_archived` FIX sentences that name `channel`;
- give `invalid_request` a neutral "the service did not accept these arguments" with FIX;
- phrase the post-path `forbidden` as the CLI does: the signal is not one this agent may reply to or reach; check `signal_id` or `to`; access may also have changed;
- make the unlisted-4xx fallback next_step neutral, not PERSON.

Add a stdio test with the edge's real codes.

### B. RIGOUR: the partial-prefix cap has no control, and the "largest check" assertion cannot fail

- The partial-prefix behaviour is correct (P11). But mutation M4a, which commits the full page cursor when only a prefix was shown (`commit(lastVisibleId && undefined)`), leaves all 17 tests green. The only cap control forces zero visible messages (`mcp-stdio.test.ts:460-467`). LANE R5's "Restoring a full-page commit: exit 1" is true only for the zero-visible case.
- `mcp-stdio.test.ts:468-474` asserts `byteLength(capFreshCheck(largest).output) <= MCP_RESULT_MAX_BYTES`. `capFreshCheck` returns a result at or under the cap for every input, because it falls back to `capMcpResult`, so this assertion cannot fail. The assertion that proves the bound is that nothing was dropped: `largest.lastVisibleId === <last message id>`.

### C. RIGOUR: renewal codes outside the table get generic sentences, and the coverage scan is a typed file list

- `RenewalRevoked("predecessor_superseded", …)` (`renewal.ts:~889`) and `RenewalRevoked("successor_not_recoverable", …)` are not in `MCP_ERROR_SENTENCES`. They fall to "The service returned predecessor_superseded." with PERSON. For `predecessor_superseded`, the producer's own advice was to run again (RETRY). The `RenewalRefused` successor-shape codes (`malformed_successor`, `incomplete_successor`, `successor_expiry_missing`, `successor_ttl_too_long`, `malformed_wake`) also fall to the fallback. No shell text leaks.
- The coverage test (`mcp-stdio.test.ts:330-343`) scans a typed list of three files, and only `AgentSetupError`. Renewal and `SessionContextError` codes are not derived. Measured: the 38 `AgentSetupError` codes missing from the table are all in setup, onboarding, hook, receive and grok-bot modules. None is reachable from an MCP tool path today.

### D. RIGOUR: small consistency points

- `SIGNAL_RECIPIENT_MAX = 80` (`src/cloud/signal-limits.ts`) now also bounds the **CLI** `--to` through the shared `resolveSignalRecipient` (`signals.ts:1481`). Agent names are bounded at 80 on the edge (`command/index.ts:2361`, `H0_REGISTRATION_NAME_MAX`), but member `display_name` is `text NOT NULL` with no bound (`20260723000001_p1_schema.sql:113`). A member whose display name is longer than 80 characters can no longer be addressed by name from the CLI; the UUID still works. The new sentence "signal recipient name is too long or empty" also replaces the old "not a live member" for `--to ""`. The other CLI recipient messages are unchanged, and `signals.test.ts` passes.
- The `channel` schema advertises a lowercase-only pattern, but enforcement normalises (trim and lowercase) before matching (`tools.ts:46-50`). Enforcement is looser than advertised. The safe direction, but not "exactly the advertised pattern".
- 426 `upgrade_required` next_step PERSON says "restore this agent's access". A person must update the client, so the action is right but the wording is loose.

## Not established

- The live Done-for-release-1 items: production controls per tool, Claude Code and Codex transcripts, npm.
- A real concurrent hook `cswarm check` process racing the MCP commit. The forward-only merge is proven by the lane test's simulated interleaving and by mutation M3, not by two processes.
- The full `npm test` and `test:p1-cli` gates were not re-run by me. The LANE reports 960/962 and 868/871, with the failures from `ps` EPERM in the sandbox.

## Ruling

Round-1 findings 1, 3, 4, 5, 7, 8, 9, 10, 11 and 14 are fixed, each with a discriminating control. Finding 6 is fixed, with one control gap (B). Finding 2/12's remaining defect is new finding A: a false diagnosis and a false next step reach the model for common, correctable refusals, including the reply refusal the ruling named. A is measured on both the lane build and the release bundle.

VERDICT: FAIL
