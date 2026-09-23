# MCP lane 2, release 1 — local evidence

Branch: `lane/mcp-stdio`, based on `adef94b4`. This lane made no production request and did not run a model, a live workspace, or a deploy.

## Built and proved

| Brief decision | Implementation | Local proof |
|---|---|---|
| 1. Library-backed stdio | `src/mcp/server.ts` uses the MCP SDK server and stdio transport. Reads use `checkAgentMessages`, `cachedAgentMessage`, and `readAgentSignalDirectory`; writes use `ThinCommandClient.sendSignal`. No table handler or child command is called. | `mcp-stdio.test.ts` drives a real SDK client through the CLI process and loopback command/read edge. It parses every captured stdout line as JSON-RPC. |
| 2. Process-only profile and host ID | The `mcp` CLI row accepts `--profile` and `--host-session-id`; neither appears in tool schemas. A live local managed context without a host ID stops startup with `host_session_required`. One profile fixes the principal and workspace. | Managed-principal refusal and all-tool deny-set tests. |
| 3. Seven tools | Only `whoami`, `check`, `ask`, `note`, `reply`, `working_on`, and `members` are advertised. | Tool-list equality and one happy path plus refusal per tool. |
| 4. MCP argument allow-lists | `src/mcp/tools.ts` declares independent JSON schemas with `additionalProperties: false`, validates them in the server, and reads body/about limits and request-ID pattern from enforcement constants. | All denied flag names and snake-case forms are absent from all seven schemas; each is sent through `tools/call` and receives `-32602`. |
| 5. Result allow-lists and cap | The same tool table names the result mapper. Identity, roster, check, and signal outputs select fields explicitly; every success and error has a 32 KiB JSON text cap and a `truncated: true` overflow marker. | Result key assertions, token/grant/profile/shell exclusion checks, cap test, and stdout parsing. |
| 6. Request-ID idempotency | `request_id` is passed as `commandId` directly, ahead of pending-intent IDs. Ambiguous transport/5xx outcomes return `unknown` with a same-ID retry hint; 409 stops. | Same ID twice yields one fake-edge signal; a committed write whose answers are lost remains one signal after retry; 409 sends no fresh ID; cancellation after send start puts unknown on the stdio wire. |
| 7. Check cursor | The check library caches full bodies, and MCP defers cursor commit until the SDK transport has written the response. `check {message_id}` reads one cached full body. | Preview/full-text and second-check cursor tests; source trace of deferred commit. |
| 8. Renewal and typed errors | Each network call opens the profile's file-backed credential session and obtains one bearer through its existing lock/one-shot path. Setup, command HTTP, and renewal classes map to structured tool errors; calls leave the server alive. | Refusal calls preserve server code, status, and sentence. A real stdio test with an expired fixture credential proves one 426 renewal exchange per call and a still-running process; class mapping also covers reauthorisation, revocation, and suspension. |
| 9. CLI table | `mcp` is a visible stdio-only bootstrap row with `tool: null`, native profile, and kept host session. | Command-dispatch baseline, table metadata tests, and released artifact `mcp --help`. |

## Mutation controls

- Adding `profile` to a copied advertised schema makes the deny-set assertion fail.
- Adding a plain table-handler line to captured stdout makes JSON-RPC parsing fail.

## Gates

| Gate | Exit | Count or result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build and executable CLI completed. |
| `env -u FORCE_COLOR npm test` (isolated `HOME`) | 1 | 960/962 pass; two existing `ps` checks fail with sandbox `EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` (isolated `HOME`) | 1 | 857/860 pass; three existing `ps` checks fail with sandbox `EPERM`. The dispatch baseline passes. |
| `npm run check:tests` | 0 | Test TypeScript type check completed. |
| Focused MCP, citation, and body-limit tests | 0 | 13/13 pass, including the final uppercase-UUID and renewal cases. |
| `bash scripts/build-release.sh` | 0 | CJS bundle built and executed by the script. |
| Copied `dist-release/cswarm mcp --help` from a temporary directory | 0 | One MCP help row; empty stderr. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors after commit. |
| `bash scripts/check-agent-trailers.sh --range origin/main..HEAD` | 0 | 1/1 commit checked. |
| `bash scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 2/2 author and committer addresses checked. |

## Not established here

- No production control, hosted Claude Code/Codex transcript, npm publication, or release was performed; those are lead-owned.
- The sandbox forbids `ps`, so existing CLI tests that inspect the process table cannot pass here.
- A copied release bundle runs outside this repository as intended by the release script. Directly executing the CJS file in this repository's ESM package scope is a pre-existing Node parse mismatch; no packaging change was made in this lane.
- A host's willingness to retry the same MCP arguments after a lost result was not measured.
- Startup refusal was proved with a valid local managed context. A managed principal whose local context is absent was not exercised; the hosted service remains the authority for rejecting a missing session proof on calls.

## Fold 1 (2026-09-23)

This section supersedes the earlier rows about pass-through error sentences, `replayed`, cancellation output, and cursor commit. All probes used a loopback fake edge and temporary profiles. No live workspace was contacted.

Implementation commit: `f8f2dec0`.

| Ruling | Change | Discriminating test and mutation result |
|---|---|---|
| R1 | `src/mcp/errors.ts` owns all model-facing error sentences and next steps. It maps typed setup, command, read, recipient, renewal, session, and timeout failures by code or class. Producer prose never passes through. HTTP status is omitted for a renewal domain refusal carried by HTTP 200. | The stdio error test drives read, recipient, command, and renewal producers, checks the owned sentence, and derives setup-code coverage from the enforcement constructors. Reintroducing producer pass-through: exit 1, 1/1 selected test failed. |
| R2 | A post failure after `sendSignal` begins, including response validation or projection failure, returns `unknown` and preserves the request ID. Only a typed 4xx code is definitive. | The fake edge commits once, returns a malformed accepted response, and the same-ID retry replays once. Replacing unknown with a thrown error: exit 1, 1/1 failed. |
| R3 | Removed `seenRequests`, the local conflict gate, and the unsupportable `replayed` result field. The command edge receives repeated IDs and decides conflicts. | The stdio result-key and same-ID tests check five fields and an edge-reaching retry. Restoring `replayed`: exit 1, 1/1 failed. |
| R4 | Removed unsolicited JSON-RPC response on cancellation; the retry instruction stays in tool descriptions. | The SDK-client cancellation test sees no result on the cancelled ID and proves a same-ID retry reaches the edge. Restoring the unsolicited response: exit 1, 1/1 failed. |
| R5 | Fresh check results shrink to a visible prefix under `MCP_RESULT_MAX_BYTES`; only its last visible message can advance the cursor. Zero visible messages leave it unchanged. | The max-size calculation uses check page and body-budget constants. A forced cap proves the next check still sees the unseen message. Restoring a full-page commit: exit 1, 1/1 failed. |
| R6 | Deferred commit re-reads `check.json` under the lock, moves forward only, preserves newer cache rows, and deletes callbacks on write error or cancellation. | The forward-merge test keeps a hook check's later cursor and cached full body. Replacing the re-read with the stale snapshot: exit 1, 1/1 failed. Moving commit before the write: exit 1, 1/1 failed. |
| R7 | Stdio capture begins immediately after child spawn, before SDK connect, and continues through child close. | The all-tool stdout parser covers the whole lifetime. Injecting a startup banner before `serveMcp`: mutant build exit 0, selected test exit 1 (1/1 failed); clean rebuild exit 0. |
| R8 | The CLI dynamically imports the MCP server inside its handler. | TypeScript AST test rejects a static `./mcp/` import and requires the dynamic import. Adding a static import: exit 1, 1/1 failed. |
| R9 | Request-ID bounds, duration parser and grammar, channel slug bounds and normalization, and recipient selector bound are shared with CLI enforcement. UUID schema advertises the uppercase variant characters it accepts. | Stdio schema test checks invalid durations, bounds, and normalized channel posting. Removing the channel bound from the advertised schema: exit 1, 1/1 failed. |
| R10 | Dispatch baseline now includes missing profile, unreadable profile, and manual host session rows that reach MCP policy. Prior 1,258 row values are byte-identical after JSON comparison; three rows were added. | Baseline records 1,261 rows. The focused fixture assertion checks the three codes. Removing a row: exit 1, 1/1 failed. |
| R11 | Managed detection still uses local session contexts at startup. | The managed-context startup test checks `host_session_required`. Changing that refusal code: exit 1, 1/1 failed. A managed context absent from this host remains **not established**. |
| R12 | Cached full-text messages include `sender_owner_relation`. | Stdio check and cached-read assertions retain the relation. Dropping it: exit 1, 1/1 failed. |
| R13 | The brief now quotes and dates corrections to decisions 5 and 6. | A document assertion checks both corrections. Removing one correction marker: exit 1, 1/1 failed. |

### Fold 1 gates

| Gate | Exit | Count or result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build and executable CLI. |
| `env -u FORCE_COLOR npm test` (isolated home) | 1 | 960/962 pass; two existing process-table checks fail because `ps` is denied by the sandbox. |
| `env -u FORCE_COLOR npm run test:p1-cli` (isolated home) | 1 | 868/871 pass; three existing process-table checks fail because `ps` is denied by the sandbox. The dispatch baseline and 17 MCP stdio tests pass. |
| `npm run check:tests` | 0 | Source and test type check. |
| Focused MCP stdio test | 0 | 17/17 pass. |
| `bash scripts/build-release.sh` | 0 | Single-file release bundle built and execute-checked. |
| Copied release artifact `mcp --help` from an external temporary directory | 0 | One MCP help entry; empty stderr. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors after implementation commit. |
| `bash scripts/check-agent-trailers.sh --range origin/main..HEAD` | 0 | 2/2 commits checked at `f8f2dec0`, including the original lane commit. |
| `bash scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 4/4 author and committer fields checked at `f8f2dec0`. |

### Not established in fold 1

- Local managed detection cannot prove a managed principal whose context exists only elsewhere. The hosted service decides whether a call without session proof is authorized.
- Rare producer classes such as a renewal lock timeout were mapped with constructed class controls, not all forced through the stdio fake edge. Stdio probes exercised setup, credential, read HTTP, malformed read, recipient, command HTTP, upgrade, and several renewal classes.
- Production controls, live Claude Code and Codex transcripts, npm publication, and deployment are lead-owned and were not attempted.
