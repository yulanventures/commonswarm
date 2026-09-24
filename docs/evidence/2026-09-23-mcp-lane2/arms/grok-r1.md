I'll review lane 2 against the brief and the Maker's record, without changing files or touching production. First I'm reading the specification, the lane record, and the diff.The brief and the new server are in hand. Next I am checking error text, cursor commit, request-id handling, and the dispatch baseline against the clauses that can fail a release.The lane fails release 1. Three production defects are in the tool-result path: a shell command is copied into tool errors, `request_id` is decided in memory before any 409, and the check cursor commits after a result that no longer contains the messages.

## PRODUCTION

**1. Classified error text reaches the model with a shell command.** `mapMcpError` copies the message of every `AgentSetupError`, `CommandHttpError`, and the listed renewal classes, and redacts only the exact profile-path string.

```15:26:src/mcp/server.ts
export function mapMcpError(error: unknown, profilePath: string): { code: string; message: string; next_step: string; status?: number } {
  const classified = error instanceof AgentSetupError || error instanceof CommandHttpError ||
    error instanceof RenewalReauthorisationRequired || error instanceof RenewalRevoked ||
    error instanceof RenewalSuspended || error instanceof RenewalRefused || error instanceof RenewalRetryError;
  // ...
  const message = classified && error instanceof Error
    ? error.message.replaceAll(profilePath, "[private profile]")
    : "The CommonSwarm tool could not complete this request.";
```

`bearer()` rethrows `RenewalReauthorisationRequired` (`src/cloud/renewal.ts:900-903`). That class is built with `reauthorisationMessage`, which is a mint command:

```321:328:src/cloud/renewal.ts
  return [
    `CommonSwarm stopped renewing the credential for ${who}: it ${cause}.`,
    "Nothing is lost or broken. Renewing forever without asking anyone is the thing this deliberately does not do, so a person confirms the agent should keep working.",
    "Whoever set this agent up issues a new credential — in the browser on the connect page, or with:",
    `  cswarm token mint --principal-id ${
      principalId ?? "<the agent principal id>"
    } --run-id <a fresh uuid> --task-id <a fresh uuid> --epoch 0`,
```

The same pass-through carries other commands the model is told to run: `src/cloud/agent-check.ts:72` ("Try cswarm check again"), `src/cloud/agent-check.ts:176` ("use cswarm inbox"), `src/cloud/agent-profile.ts:143` ("Run cswarm setup"), and `src/cloud/agent-profile.ts:219` ("Check cswarm session status"). D-004 (`LOCALLY_EXPIRED_MESSAGE`, `renewal.ts:364-365`), D-011 (`UNEXPLAINED_REFUSAL_MESSAGE`, `renewal.ts:366-368`), and the one-shot 426 sentence (`renewal.ts:472-473`) are preserved and do not themselves name a command line. Token strings, grant ids, and device ids are not interpolated into those classified sentences.

Lock and cache paths do not come through this mapper. `storage.ts:126-170` throws plain `Error`s that include the directory or file path, and `mapMcpError` replaces those with the generic sentence. `AgentCredentialInputError` includes the credential-file path (`src/cloud/agent-credential-input.ts:67-86`) and is also unclassified. The success-path check fields `full_text_command` and `next_action` are not copied; `mapCheck` writes `full_text_tool` instead (`src/mcp/tools.ts:53-60`).

**2. `replayed` and `command_id_conflict` are decided in this process, before a 409.** The fingerprint is stored before `sendSignal`, and `replayed` is that local hit:

```127:152:src/mcp/server.ts
          const fingerprint = JSON.stringify(command);
          const prior = seenRequests.get(args.request_id!);
          if (prior !== undefined && prior !== fingerprint) throw new AgentSetupError("command_id_conflict", "This request ID was already used with different arguments. Stop and use a new ID only for a new intent.");
          seenRequests.set(args.request_id!, fingerprint);
          // ...
            if (error instanceof CommandTransportError || (error instanceof CommandHttpError && error.status >= 500) || extra.signal.aborted) {
              output = { outcome: "unknown", retry_with_same_request_id: true };
              break;
            }
          // ...
          output = tool.mapResult(sent, prior !== undefined);
```

A first attempt that throws `CommandTransportError` ("signal request failed before a response", `src/cloud/command-client.ts:1386-1388`) or a 5xx before the server stores the command still occupies the id. The retry is labeled `replayed: true` when this call is the first one the server accepted. A changed fingerprint throws `command_id_conflict` with no request and no status 409. The message tells the model to use a new id; `next_step` says stop (`server.ts:28-30`). `channel` is not checked with `channelSlugProblem` before that store (`tools.ts:18`), so a rejected channel and a corrected retry of the same id collide locally. A real server 409 still does not mint another id (`command-client.ts:1364-1365`, `1448-1451`). The in-memory map is also dropped on process restart and after 1,024 entries (`server.ts:131`).

**3. The check cursor commits when the written result is no longer the messages.** The commit runs for every JSON-RPC result after `rawSend` resolves:

```59:65:src/mcp/server.ts
  transport.send = async message => {
    await rawSend(message);
    if ("id" in message && message.id !== undefined) {
      const commit = commitAfterWrite.get(message.id);
      commitAfterWrite.delete(message.id);
      if ("result" in message && commit) await commit();
    }
  };
```

The handler always sends `capMcpResult(output)` (`server.ts:155`). Over the cap, that value is replaced wholesale:

```86:90:src/mcp/tools.ts
export function capMcpResult(value: object): object {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) <= MCP_RESULT_MAX_BYTES) return value;
  return { truncated: true, message: "Result exceeds the MCP byte cap. Narrow the request or use the CLI outside the model session." };
}
```

The replacement has no `message_id`. The cursor callback registered at `server.ts:106` still runs, because the envelope is a `result`. Full bodies were already written to `check.json` before that callback (`agent-check.ts:223-229`). A later `check` will not return those rows, and the model has no id to pass to `check {message_id}`. A normal preview page stays under 32 KiB (`AGENT_CHECK_BODY_BUDGET` is 4,000). The mapper still copies `workspace_name` with no client length check (`signals.ts:1374-1385`, `tools.ts:54-55`), and any over-cap check takes this path. `StdioServerTransport.send` resolves when `stdout.write` returns true or on `drain`, and it never rejects (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:69-78`), so a stream error after a buffered write still commits. A cancelled check does not: the SDK returns without sending when the handler signal is already aborted (`protocol.js:369-372`), and the callback is only invoked from `transport.send`.

## RIGOUR

**Read refusals drop the server sentence.** `throwSignalHttp` throws a plain `Error` (`signals.ts:682-688`). `mapMcpError` turns that into `mcp_call_failed` and the generic sentence. The test only checks `isError` for `whoami`, `members`, and `check` (`tests/p1-cli/mcp-stdio.test.ts:160-161`). `LANE.md:16` says refusal calls preserve code, status, and sentence. That is true for the send 403s in the same test (`mcp-stdio.test.ts:163-168`), and false for reads.

**Schemas.** The UUID pattern is `ONBOARDING_UUID.source.replaceAll("a-f", "a-fA-F")` (`tools.ts:17`), which leaves the variant class `[89ab]`. Validation then adds the `i` flag (`tools.ts:46`), so the server accepts variant `A`/`B` while the advertised pattern does not. The uppercase test id uses variant `8` (`mcp-stdio.test.ts:149`), which both accept. `channel` is an unbounded string (`tools.ts:18`); the CLI refuses the same field with `channelSlugProblem` before send (`cli.ts:3243-3248`). `until` is a second copy of `signalDuration` (`server.ts:33-40`, `cli.ts:3273-3288`), not an exported function, and an invalid duration is an `AgentSetupError` rather than `-32602`.

**Evidence gaps.** The request-id test never fails the fetch before the server sees the post. The cursor test never exceeds the cap, fails the write, or cancels the call. The shell exclusion is `!text.text.includes("cswarm check --")` (`mcp-stdio.test.ts:113`), which does not see `cswarm token mint` or `cswarm check again`. `--host-session-id manual` is rejected in code (`server.ts:51-53`) and is not in the managed-principal test.

## What holds

The seven tools, deny-set, and `-32602` positive control match the brief (`tools.ts:23-31`, `mcp-stdio.test.ts:22-26` and `131-139`). `--host-session-id manual` and a blank id are refused at start, and a live local managed context without an id exits `host_session_required` (`server.ts:47-53`). One-shot renewal is the default `listenerMode` (unset, `renewal.ts:676` and `904-917`); the expired-credential test records one 426 exchange per call. A server 409 does not mint a new command id. Cancellation does not send a second JSON-RPC result: the abort listener is removed in `finally` before the handler returns (`server.ts:151`), and the SDK suppresses its own response once that signal is aborted (`protocol.js:369-372`). The `mcp` row is `tool: null`, `profile: "native"`, `hostSessionId: "keep"`, stdio-only, and one help line (`cli.ts:9395-9399`). `tests/p1-cli/mcp-stdio.test.ts` is included by `npm run test:p1-cli` (Node's glob; the shell leaves `**` unexpanded).

The 858-line baseline rewrite is the new help line plus 10 new `mcp` rows. Against `origin/main`, all 1,248 shared rows keep their exit code and handlers. The only text change on those rows is the inserted line `cswarm mcp --profile <path> [--host-session-id <id>]  # MCP server over stdio` (332 stderr usage blocks, 5 stdout usage blocks).

VERDICT: FAIL
