# Checker review (Claude Opus arm): item H lane 2, `cswarm mcp` over stdio, release 1

- Lane: `lane/mcp-stdio`, SHA `064a1cdd`, base `adef94b4` (= origin/main merge-base). Diff read: `git diff origin/main...064a1cdd`.
- The spec is `docs/design/2026-09-23-MCP-LANE-2-BRIEF.md`. The Maker's record is `docs/evidence/2026-09-23-mcp-lane2/LANE.md`.
- The worktree `scratchpad/arms-mcp` was at `1985b063` when I started. I confirmed `064a1cdd` before I relied on it. All measurements come from a `git archive 064a1cdd` copy at `scratchpad/mcp/opus-probes/src064` (built with `npm run build`, `node_modules` symlinked). I changed no tracked file. I contacted no host other than 127.0.0.1 loopback fakes, and I started no model CLI. All probe processes have stopped.
- Probes: `src064/probes/probe.test.ts` (P1-P8, SDK stdio client against the built `dist/cli.js mcp` and a loopback fake edge, the same pattern as the lane test) and `src064/probes/capmax.ts`. I ran two mutations in a throwaway copy, `srcmut`, and deleted it after.
- Baseline: the lane test passes at the SHA (6/6). `command-dispatch-baseline`, `signal-body` and `citation-drift` pass (8/8).

## Findings

### 1. PRODUCTION: shell commands reach the model in tool results

`src/mcp/server.ts:24-26`
```ts
const message = classified && error instanceof Error
  ? error.message.replaceAll(profilePath, "[private profile]")
  : "The CommonSwarm tool could not complete this request.";
```
The brief's goal says "no token, profile path or shell command ever appears in … a tool result". Done-for-release-1 checks the transcripts for this. The mapper passes every classified message through verbatim. These producers put a shell command in front of the model:

| Producer | Sentence (excerpt) | Reachable per call | Measured |
|---|---|---|---|
| `RenewalReauthorisationRequired` via `reauthorisationMessage` (`src/cloud/renewal.ts:311-329`) | `cswarm token mint --principal-id <id> --run-id <a fresh uuid> --task-id <a fresh uuid> --epoch 0` / "Pipe the JSON it prints to this agent" | yes (`bearer()` rethrows it, renewal.ts:902-905) | **P3**: `whoami` isError, message contains the full `cswarm token mint …` line |
| `RenewalSuspended` via `standingPausedRenewalMessage` (`src/cloud/renewal-grants.ts:189`) | "… runs cswarm grant resume, then this agent continues." | yes | **P3**: `renewal_idle_suspended` message contains `cswarm grant resume` |
| `check_timeout` (`src/cloud/agent-check.ts:70-73`) | "Try cswarm check again" | yes. MCP `check` inherits the 3.9 s hook budget (`AGENT_CHECK_TIMEOUT_MS`) | **P8**: a 4.5 s read delay gives `{"code":"check_timeout","message":"The message check timed out. Try cswarm check again; …"}` |
| `check_paging_unsupported` (`agent-check.ts:176`) | "use cswarm inbox to read it" | yes | code |
| `profile_missing` (`agent-profile.ts:143`) | "Run cswarm setup with the connection file." | yes (`checkAgentMessages` and `cachedAgentMessage` read the profile on every call) | code |
| `profile_session_conflict` (`agent-profile.ts:219`) | "Check cswarm session status" | yes (`authenticated()` calls `profileSessionContext` on every call) | code |

Paths: I found no classified producer that carries a path. The credential-file path exists only in `AgentCredentialInputError` (`agent-credential-input.ts:66-88`), which is unclassified and so becomes the generic sentence. Lock and cache paths exist only in unclassified storage errors. The profile path is replaced exactly. Tokens: none found.

The lane's own control pins the wrong claim. `tests/p1-cli/mcp-stdio.test.ts:202-213` builds the renewal errors with hand-written messages ("Ask the owner to authorise again.") and asserts `mapped.message === error.message`. That is pass-through. The production sentences contain the commands above.

The brief's D-004/D-011/426 "existing sentences" (`LOCALLY_EXPIRED_MESSAGE`, `UNEXPLAINED_REFUSAL_MESSAGE`, `RENEWAL_UPGRADE_COMMAND_ACTION`) contain no shell command. The leaks come from other classes. A fix needs MCP sentences keyed by code, generated from one table, plus a test that runs every classified producer's real message through `mapMcpError` and asserts `!/\bcswarm [a-z]/`.

### 2. PRODUCTION: unclassified errors collapse to "could not complete … try again"

`src/mcp/server.ts:16-26` classifies only `AgentSetupError`, `CommandHttpError` and five renewal classes. Everything else becomes `{"code":"mcp_call_failed","message":"The CommonSwarm tool could not complete this request.","next_step":"Follow the message and try again when ready."}`. Brief decision 8 says usage errors map to `{code, message, next_step}`. Producers that reach this generic sentence:

- **Unknown or ambiguous `to`**: `resolveSignalRecipient` throws a plain `Error` (`src/cloud/signals.ts:1486-1520`). The ambiguous case carries the ids to use instead. **P2 measured**: `ask {to:"Nobody"}` gives the generic sentence above. The model cannot correct a mistyped recipient.
- **Every read-edge refusal** (whoami, members, check, ask/note with `to`): `throwSignalHttp` throws a plain `Error` and keeps the status in a weak map (`signals.ts:674-689`). A revoked or expired credential refused by the read edge (the D-011 case), a read 426, or a 429 all show as "could not complete … try again". There is no status, code or sentence. The lane test only asserts `isError` (`mcp-stdio.test.ts:160-161`).
- `SignalMalformedError`, `SignalTransportError`, `RenewalOutcomeUnknown`, `RenewalUnsupported`, `RenewalCredentialCheckError`, `SessionContextError`, `FileLockTimeoutError` (the last on the renewal lock, not the check lock).

### 3. PRODUCTION: a committed write can be reported as a failure, not `unknown`

`src/mcp/server.ts:145-150` returns `unknown` only for `CommandTransportError`, 5xx, or abort. `ThinCommandClient.sendSignal` throws a plain `Error` after a **2xx**: "signal endpoint accepted without a signal receipt", "client upgrade required (minimum …)" (`src/cloud/command-client.ts:1428-1446`), or a raw body-parse error (`bodyOutcome.error`, same function). **P4 measured**: in both `min_version` and `no_signal` modes the fake edge committed 1 signal, and the model got `mcp_call_failed` / "try again when ready". Brief decision 6 says an answer lost after the send started is `unknown`. "Try again" without "same request_id" invites a new id, which makes a duplicate. The likelihood is low: it needs a server anomaly.

### 4. PRODUCTION (claim): `replayed` is process memory, not a server fact

`src/mcp/server.ts:128-130, 152`
```ts
const prior = seenRequests.get(args.request_id!);
...
seenRequests.set(args.request_id!, fingerprint);
...
output = tool.mapResult(sent, prior !== undefined);
```
- **P1 measured**: the first `note` with `request_id=probe0001` was refused (403, nothing created). The retry with the same id created the signal fresh (server created 1). The result said `"replayed":true`.
- After a process restart, a real replay reports `replayed:false`. The server's replay answer has no marker (`supabase/functions/command/index.ts:2755-2768`, `replayResult`), so the field cannot be derived as named. Drop it, or rename and describe it as "this process sent this request_id before".
- `seenRequests` is state shared between calls. Brief decision 1 says "no module-level state is shared between calls". The map is closure-level, but the effect is the same.
- The lead's question: a same-id retry after `unknown` does reach the server with the same `command_id`. The fingerprint is identical and `commandId: args.request_id` is set (P1 and the lane test at `mcp-stdio.test.ts:238-243`). The local pre-check decides a conflict before the server does. It returns `code: command_id_conflict` with no `status`. That is stricter than the brief ("a 409 decides") and does not contradict it. The server-409 path is also covered (`mcp-stdio.test.ts:247-253`).

### 5. PRODUCTION (protocol): an unsolicited response on a cancelled id, which the host never delivers

`src/mcp/server.ts:133-140`
```ts
// The SDK suppresses its ordinary response after cancellation. Once a write has
// started, send the explicit unknown outcome on the same JSON-RPC id.
const cancelled = () => {
  if (sending) void transport.send({ jsonrpc: "2.0", id: extra.requestId, result: unknown }).catch(() => undefined);
};
```
The MCP cancellation rules say the receiver should not send a response for a cancelled request, and the sender ignores one. **P5 measured** with the SDK client:
- The caller got `MCP error -32001: AbortError: This operation was aborted`.
- The `unknown` payload arrived only as `client.onerror`: `Received a response for an unknown message ID: {"jsonrpc":"2.0","id":1,"result":{…"outcome":"unknown"…}}`.

So the value never reaches the host or the model. The lane test `mcp-stdio.test.ts:272-287` greps the server's stdout bytes. Its own `await assert.rejects(call)` proves the host never received the value. The negative result does not reach the path it claims. The brief's "a tool call that was cancelled … returns unknown" cannot be met over MCP. Remove the unsolicited send. The `instructions` string and the tool descriptions already carry the retry-with-same-id rule.

### 6. RIGOUR: the byte cap would mark unseen messages read. It cannot trigger today, and no test holds that bound

`src/mcp/server.ts:59-66`: the commit runs for any `"result"` message, including a capped one (`server.ts:155`, `tools.ts:86-91`, which replaces the whole result). So a capped fresh `check` would advance the cursor past messages the model never saw. Measured worst case (`probes/capmax.ts`, 20 messages, 80-character workspace name):

| Content | fresh check (20×200) | fresh check (4×1000, truncated) | cached check (8000) | cap |
|---|---:|---:|---:|---:|
| CJK (3 B/char) | 17,466 | 13,702 | 24,219 | 32,768 |
| `"` (2 B) | 13,466 | 9,702 | 16,219 | 32,768 |
| control chars (6 B; stripped by `supabase/functions/_shared/signal-text.ts`) | 29,466 | 25,702 | 48,219 | 32,768 |

Suspicion 1 is therefore **not reachable** under the current `AGENT_CHECK_BODY_BUDGET` (4,000), `AGENT_CHECK_PAGE_SIZE` (20) and the edge sanitiser. The coupling has no test. Raising the budget or the page size would make this path lose messages without warning. `members` has no bound: about 400 rows replace the whole roster with a message. Recommended: skip the commit when `capMcpResult` applied, and add a test.

### 7. RIGOUR: decision 7 has no discriminating control, and the deferred commit writes a stale snapshot

- Mutation (measured): in `server.ts:59-66` I moved the commit **before** `rawSend` and made it run on every message. All 6 lane tests stayed green. The LANE's "source trace of deferred commit" is the only evidence.
- `src/cloud/agent-check.ts:228-230` re-takes the lock and writes `{ ...cached, cursor }` from the snapshot taken under the earlier lock. `check.json` is shared per profile with the host-hook `cswarm check` (`agent-check.ts:117-121`). A hook check that runs between the MCP response and its commit can have its later cursor overwritten, which regresses it and gives replays. It can also lose its cache rows, so `check {message_id}` for those gives `message_not_cached`. The window is milliseconds. Not measured.
- `commitAfterWrite` entries for cancelled `check` calls are never deleted (`server.ts:57, 106`).

### 8. RIGOUR: the stdout-purity test cannot see start-up output

`tests/p1-cli/mcp-stdio.test.ts:103` attaches the stdout capture **after** `client.connect`. Mutation (measured): I added `process.stdout.write("BANNER not json\n")` before `serveMcp` in the `mcp` handler. The "every happy path" test stayed green. Its "mutation control" (`:179`) proves only that `JSON.parse` throws on non-JSON. By inspection and measurement I found no stdout write on the per-call paths: the renewal warning goes to stderr (`renewal.ts:761-762`, **P7**: `cswarm: The deployment refused to renew … went ahead …` on stderr, stdout all JSON). Suspicion 7 is refuted for the served paths. The gate still misses the start-up window.

### 9. RIGOUR (performance): a static SDK import adds about 45 ms to every CLI start, including the hook `check`

`src/cli.ts:4` `import { serveMcp } from "./mcp/server.js";`. The repo loads the SDK lazily elsewhere (`src/onboarding-cli.ts:210,224`). Measured `node dist/cli.js --version`, 15 runs × 2 each: adef94b4 mean **84.0 / 72.4 ms**, 064a1cdd mean **125.2 / 124.5 ms**. Importing `dist/mcp/server.js` alone takes 47 ms. The hook start-up allowance was sized from a measured p95 of 90 ms (`src/cloud/agent-check-budget.ts:4-9`). Fix: `const { serveMcp } = await import("./mcp/server.js")` inside the handler.

### 10. RIGOUR: schema constants retyped or missing

- `src/mcp/tools.ts:16` `string(72, 8, H0_REQUEST_ID_RE.source)` retypes the `{8,72}` of `H0_REQUEST_ID_RE` (`src/h0/verbs.ts:106`). `uuid` retypes 36/36.
- `src/mcp/server.ts:33-41` `untilMilliseconds` copies `signalDuration` (`src/cli.ts:3273-3289`: the regex, the 30-day cap and the units). Brief decision 1: "export it; do not copy it". `until` is advertised with no pattern, so a bad value is an `isError` result, not `-32602` (P2: `until_invalid`).
- `channel` is advertised with no `maxLength` or `pattern`, though `CHANNEL_SLUG_MAX` and `CHANNEL_SLUG_RE` exist (`src/cloud/channels.ts:31,71`). The CLI's `channelSlugProblem`/`normalizeChannelSlug` (`cli.ts:3243-3249`: trim and lowercase) is skipped. **P2 measured**: a 5,000-character `channel` passed validation and was posted. `to` is unbounded.
- `tools.ts:46` applies the `"i"` flag to every pattern, so enforcement differs from the advertised, case-sensitive JSON Schema. The advertised uuid pattern keeps `[89ab]` lowercase: an uppercase variant nibble passes enforcement and fails the advertised schema. This is cosmetic.
- The deny-set gate and its `-32602` control (`mcp-stdio.test.ts:22-27, 127-140`) reach the path they claim. All 40 names × 7 tools are refused by `validateMcpArguments`' allow-list branch (`tools.ts:40-42`), and happy paths on the same path are accepted. That is correct.

### 11. RIGOUR: the dispatch-baseline delta is clean, but the new rows never reach `mcp` policy

Measured by parsing both fixtures: 1248 → 1258 rows. 337 rows changed, and after removing the one new help line the residual is **0**. 10 rows were added and none removed, so suspicion 8 is refuted. But every added `mcp` fixture carries a positional `extra`, and all 10 stop at `assertShape` with `cswarm: [mcp_start_failed] too many positional arguments`. So `policy.host-session.mcp.keep` never reaches host-session handling. No fixture records `mcp` with a missing profile, an invalid profile, or `--host-session-id manual`.

### 12. RIGOUR: decisions 2 and 8, the details that pass and the ones that do not

- Pass: `--host-session-id manual` is refused with `host_session_invalid` (`server.ts:51-53`). A host id that matches no local context fails at start with `profile_session_conflict` (`server.ts:55`). A live local managed context with no host id fails with `host_session_required`, exit 1, empty stdout (lane test). Renewal is one exchange per call (lane test at `mcp-stdio.test.ts:217-229`, `renewals() === attempt`). A due but still-live credential with a refused renewal warns on stderr and proceeds, like the CLI one-shot (P7). D-004/D-011/426 sentences pass through, and the process keeps serving (lane test, and P3/P8 repeat calls).
- Not established (the LANE agrees): managed detection is local only (`server.ts:47-50`). A managed principal whose context is on another host, or not yet acquired, starts without `--host-session-id`.
- `next_step` is one typed sentence, "Follow the message and try again when ready.", for every code except `command_id_conflict` (`server.ts:28-30`). That contradicts the revoked and expired sentences ("renewal cannot bring it back"). `RenewalRefused(200, …)` for device refusals puts `status: 200` into an error payload (`server.ts:27`).

### 13. Suspicion 9 refuted, with one small loss

`sendSignalWithPending` (`src/cloud/pending-command.ts:255-297`) adds only a durable pending command id and a "; retry the same signal …" suffix. It has no receipts. Using `request_id` as the `commandId` fully replaces the pending id (brief decision 6). Only a CLI-side refinement is lost: the reply-refusal hint (`cli.ts:3933, 4049`). The channel normalisation in finding 10 is also lost.

### 14. RIGOUR: the cached full-text view drops the trust label

`src/mcp/tools.ts:63-66` `mapCachedCheck` omits `sender_owner_relation`, which the fresh view shows (`tools.ts:55-56`). A cross-owner message read in full loses its `cross_owner` label.

## Not established by this review

- The Done-for-release-1 items: a production control per tool, the Claude Code and Codex live runs, the transcript scan, and npm. The LANE marks these as lead-owned. None were run here.
- Findings 7 (the hook race) and 2 (read refusals) were not driven end to end. They are from code. The unknown-recipient case in finding 2 was measured.
- The full `npm test` and `test:p1-cli` gates were not re-run. I ran only the four related files.

## Ruling

Findings 1, 2, 4 and 5 are defects the model or host sees against explicit brief clauses: the goal, decisions 8, 5/6 and 6. Finding 3 is a low-probability path to a duplicate post. 1 and 5 each have a lane test that pins the wrong claim.

VERDICT: FAIL
