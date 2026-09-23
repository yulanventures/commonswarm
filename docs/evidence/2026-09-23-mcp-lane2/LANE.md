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
