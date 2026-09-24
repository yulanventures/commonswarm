I'll review this lane read-only against the release-2 spec: start with the brief, LANE.md, and the `origin/main...da5fa657` diff, then check each clause against the producers and tests.Worktree is at `da5fa657` as specified. Next I’ll inventory the lane diff and read the connect producers, CLI handlers, and tests clause by clause.Core producers next: `mcp-connect.ts`, the CLI mcp handlers, profile writer, and the two commits’ diffs.I'll read the profile writer, target resolution, CLI error paths, tests, and the onboarding/copy surfaces next.I’m checking profile-policy dispatch, target resolution, write/error paths, and whether a write failure after register tells the operator to revoke.Reviewed `lane/mcp-connect` at `da5fa657` against option A, decisions 1–6, and the Strategist TTY / single-use / profile-path-only conditions. Focused gates were green (41/41 CLI files, 12/12 site observer). Dispatch fixture counts and SHA-256 values match `LANE.md`. Two PRODUCTION holes remain.

## PRODUCTION

**1. `--code=<join-secret>` prints the join code on stderr**

`src/cli.ts:687-689` rejects any `--flag=value` token by echoing the whole token:

```687:689:src/cli.ts
      if (!name || name.includes("=")) {
        throw new Error(`invalid option: ${value}`);
      }
```

The top-level handler then writes that message (`src/cli.ts:9907`). A live `dist/cli.js` probe of `mcp connect --url http://127.0.0.1:9 --anon-key public-test-key --code=<join-secret>` exited 1 with stderr `cswarm: invalid option: --code=<join-secret>`. Parse runs before the TTY check, so an agent that passes the code on argv gets it back in the transcript.

The two-token form `--code <secret>` is clean (`unknown option: --code`). That is the only form `tests/p1-cli/mcp-connect.test.ts:131-136` covers.

**2. After `register` commits, a write/save failure does not tell the operator to revoke**

Network failure and an incomplete register body do:

```108:109:src/cloud/mcp-connect.ts
    throw new McpConnectError("register_outcome_unknown", "Registration may have committed. Ask the operator to revoke the seat and issue a new code.");
```

```125:125:src/cloud/mcp-connect.ts
    throw new McpConnectError("register_response_invalid", "Registration returned an incomplete seat. Ask the operator to revoke it and issue a new code.");
```

The save is a bare call:

```133:134:src/cloud/mcp-connect.ts
  // saveAgentProfile owns the 0700 directory and 0600 file writes. The profile is intentionally unbound.
  await saveAgentProfile(path, connection, undefined, undefined, true);
```

`saveAgentProfile` can then throw `profile_exists` (TOCTOU after the preflight) or a Node I/O error from `writeSecureJsonFile`. The MCP catch prints `[mcp_start_failed]` plus the raw message (`src/cli.ts:9806-9808`). A seat is already committed; the operator is not told to `cswarm principal revoke`. Decision 4 required that every post-register failure name the next step. No test covers this path.

Writes are atomic per file, credential then profile (`src/cloud/storage.ts:449-473`, `src/cloud/agent-profile.ts:221-222`). `check` still refuses a credential-only directory (`profile_missing`). Fail-closed for `check` holds; the operator message does not.

## RIGOUR

**3. Echo is restored in `finally`, not on signal**

```49:60:src/cloud/mcp-connect.ts
export async function readHiddenJoinCode(): Promise<string> {
  if (!process.stdin.isTTY) throw new McpConnectError("terminal_required", "Run mcp connect in a terminal to enter the code privately.");
  process.stderr.write("Connect code: ");
  terminalEcho(false);
  try {
    const input = createInterface({ input: process.stdin, terminal: false });
    try { return await input.question(""); }
    finally { input.close(); }
  } finally {
    terminalEcho(true);
    process.stderr.write("\n");
  }
}
```

Thrown errors restore echo. There is no `SIGINT`/`SIGTERM`/`exit` handler. Default SIGINT kills the process with `stty -echo` still in effect.

If `stty` is missing, `terminalEcho(false)` throws `terminal_unavailable` (`src/cloud/mcp-connect.ts:43-45`) before the try, so echo is never turned off.

**4. `LANE.md` still says connect prints the principal id**

`docs/evidence/2026-09-24-mcp-release2/LANE.md:11`: “Connect prints only profile path, principal ID, and the Claude Code and Codex install lines.” After `da5fa657`, `renderMcpConnect` prints the profile path and install lines only (`src/cloud/mcp-connect.ts:82-84`). The onboarding strings match the code; this evidence row does not.

## Clauses that hold

- **Secrets in connect producers:** `connectMcp` keeps the join code and seat token out of `McpConnectResult` and `renderMcpConnect`. Register error codes that match `swm_join_` / `swm_agt_` are replaced with `register_refused`. Invalid-code errors omit the typed value. `mcp code` prints the join code once by design (`src/cli.ts:9401`).
- **TTY before read:** `process.stdin.isTTY` is checked before readline. Piped stdin in the CLI test is `terminal_required` and writes nothing under `HOME`.
- **Single use:** one `fetch`, `attemptId: randomUUID()`, no retry. A second connect with the same code is `join_credential_seat_cap_reached` and writes nothing. Server same-`attemptId` replay (`supabase/functions/command/index.ts:6132-6187`) would replace an unused token; this client never resends that id, so a lost response strands the seat (item M, as specified).
- **Occupied path:** profile or `credential.json` is refused before the prompt and before register (`src/cloud/mcp-connect.ts:91-93`); the writer rechecks under the setup lock.
- **`mcp code`:** human session only, `seat_cap: 1`, `ttl_hours: 1`. `--profile` is `refuse`; `--agent-token-file` fails `assertShape` before any request.
- **`cswarm mcp --profile P`:** group chooser is `positionals[1] ?? "serve"` with the same `serveMcp` handler, `NATIVE_PROFILE`, `hostSessionId: "keep"`. Fixture rows `mcp.missing-profile`, `mcp.unreadable-profile`, and `mcp.manual-host-session` are byte-identical to `origin/main` (item I binding and `manual` refusal unchanged). `["mcp", "extra"]` is now the group UsageError, which is the intended group split.
- **Dispatch inventory:** 1,261 → 1,330; 78 added, 9 removed, 339 changed. Fixture SHA-256 values match `LANE.md`. Added/removed ids match the inventory.
- **Target:** `--url` is required; anon key comes from `--anon-key` or a saved current target whose normalized origin equals that URL (`src/cloud/current-target.ts:367-373`). Env keys and site discovery are not used on connect.
- **Onboarding copy:** MCP guide has no credential; fallback prompt and H0 paste state that those paths send a secret through the model.
- **`dist-release/package.json`:** `{"type":"commonjs"}` beside the in-repo bundle. `cswarm.sha256` hashes only `cswarm`. `scripts/build-npm.sh` copies `cswarm` to `cswarm.cjs` and writes a separate npm manifest. Published artifacts and the install asset list are unchanged.
- **Tests:** `test:p1-cli` globs `tests/p1-cli/mcp-connect.test.ts`. Named mutations (token in install text, `--code` two-token argv, extra register, occupied-path bypass) hit existing assertions. The `--code=` leak and post-register write path have no control.

VERDICT: FAIL
