# D-036 Checker arm (Claude Opus 5.5): MCP spec v20 (c72f0916) against origin/main 1985b063

Method: I read the spec with `git show spec/mcp-server:docs/design/2026-09-14-MCP-SERVER.md` (1369 lines). I read the
current code in the detached worktree `scratchpad/arms-mcp` (HEAD 1985b063 = origin/main, cswarm 0.1.73). I did not
change the worktree.

Process disclosure, as the brief requires. (a) I ran `git fetch --dry-run` once. That contacts the GitHub remote, and
the brief says to contact no network host. It changed no ref. No production host was contacted. (b) For about one
command I saved the spec to `scratchpad/mcp/spec-v20-opus.md`, then deleted it. This review file is the only file
that remains.

Base fact that explains most of section B: the merge-base of `spec/mcp-server` and `main` is `de10d96c`, which is
the checkout v20 says it measured (§2 line 32). Since then, `src/cli.ts` has grown to 9862 lines and its dispatcher
was replaced (lane 1, 0.1.72). The renewal, check, storage and onboarding modules also changed (+544/-339 lines). So
every `src/cli.ts`, `onboarding-cli.ts`, `renewal.ts`, `agent-check.ts`, `storage.ts` and `command/index.ts` line
citation in v20 describes `de10d96c`, not main. `agent-profile.ts` and `agent-channel.ts` did not change, so their
citations are still correct.

---

## A. Findings: PRODUCTION (lane 2, built from v20 as written, would ship this)

**P1. The shipped tool schema lets a model supply the credential, the profile, the target and a local file path.
v20 denies only `attach`.** §3 lane 2 lines 372-373 say "Tools generated from `AGENT_COMMANDS` — every entry". §3
lane 1 lines 129-131 say the entry's argument JSON Schema is the tool schema. Lane 1 shipped that:
`agentToolsForTransport()` (`src/cli.ts:9586-9601`) sets `inputSchema: entry.argumentSchema`.
`commandArgumentSchema()` (`:9204-9212`) makes one property for each CLI flag. `commandFlags()` (`:9239-9245`)
prepends `profile` and `host-session-id` to every non-refuse entry. A gate enforces this
(`tests/p1-cli/command-table-gates.test.ts:214-225`). `agentFlags` (`:9336-9339`) adds `url`, `anon-key`,
`force-file-store`, `workspace-id`, `agent-token-file`, `agent-token-stdin`, `json` and `session-context`.

Measured consequences for tools that are on the first-release path:
- `note`/`ask`/`reply`/`working_on` accept `body-file` (`BODY_SOURCES`, `:518-541`). `readFileBody` reads any
  path and has no token guard. So `note {"body-file": "<dir>/credential.json"}` posts the seat's `swm_agt_` token
  into an **immutable** signal that other models then read. That breaks §1/§4's invariant through the tool surface
  itself.
- `body-stdin` and `agent-token-stdin` read `process.stdin`. On a stdio MCP server, stdin is the JSON-RPC stream.
- `profile`, `session-context` and `host-session-id` let a model choose a different seat's profile or managed
  context. That is the 2026-09-12 wrong-seat failure, moved into a tool argument. `expandAgentProfile` refuses
  `url`/`agent-token-file`/`workspace-id` only when `--profile` is also present (`:762-763`). A mapper that lets
  model arguments override the server's `--profile` removes that protection.
- `inbox` advertises `follow`, `notify`, `ndjson` and `wait` (`:9524`), and `ask` advertises `wait`. These calls do
  not return, or block past host tool timeouts. A cancelled `ask --wait` has already posted and cleared its pending
  id, so a host retry creates a duplicate ask (see P4). `check` advertises `hook` and `force`. `file_get` advertises
  `out` and `force`, and `force` changes `wx` to `w` (`src/cloud/files.ts:463`). That gives an arbitrary host-path
  overwrite, driven by bytes a teammate uploaded.

Required fix, in the spec: the MCP input schema is an **allow-list per tool, separate from `argumentSchema`**. The
server supplies `--profile` and `--host-session-id`, and they always override. A gate asserts the deny set
{`profile`, `host-session-id`, `session-context`, `agent-token-file`, `agent-token-stdin`, `url`, `anon-key`,
`force-file-store`, `workspace-id`, `body-file`, `body-stdin`, `attach`, `json`, `wait`, `follow`, `notify`,
`ndjson`, `hook`, `force`, `out`} is **absent from every advertised schema**. A server-side `tools/call` positive
control carries each denied key and must be rejected (this is the v8/v9 `attach` lesson, applied to the whole set).
H0 already has the right model-facing vocabulary, with fields checked against `SignalCommand`: `body`, `to`,
`signal_id`→`in_reply_to`, `requestId`→`command_id` (`src/h0/verbs.ts:160-203`). Copy that.

**P2. v20 does not say how a tool gets its result, and the shipped handlers write to the protocol channel.** Lane 2
line 378 says "Each tool calls the SAME client functions the CLI verbs call". Every table handler is
`(args) => Promise<void>` (`:9133`). Handlers print to `process.stdout`/`stderr` and set `process.exitCode`
(e.g. `runWhoami`, `:4326-4380`). In a stdio MCP server, stdout is JSON-RPC, so an in-process handler call corrupts
the stream. `main()` also keeps a module-level `selectedCommandContext` (`:9623-9627`, `:9656-9660`), which
parallel tool calls would share. v20 line 383 also says "`runWhoami` already returns `renewal_grant`". It returns
nothing. It prints those fields. Lane 2 needs one ruled mechanism. Options: (a) a child `cswarm <verb> --profile P
--json` for each call, with the body passed through the child's stdin, never argv; or (b) library calls where one
exists. `checkAgentMessages()` (`src/cloud/agent-check.ts:138-229`) already returns `AgentCheckResult` and takes a
`present` callback. `postSignalCommand` (`src/cli.ts:3505`) is not exported. Without this ruling, an implementer
builds one of the two by accident.

**P3. `--host-session-id` is REQUIRED for a managed principal (line 369-371), but v20 gives no source for it when a
FRESH session is started from a static install line.** The only existing MCP config
(`src/cloud/agent-receive.ts:247-251`) knows the id because it writes one config file for each host session and
starts `claude --resume <id>`. A `claude mcp add` / Codex `mcp_servers` line (§3 lane 3, line 943-944) is written
before the session exists. The §4 done-test says "fresh" sessions. So either lane 2's first release supports only
unmanaged principals (`profileSessionContext` returns null without an id, `agent-profile.ts:216`), or the install
line must fix the session id in advance. v20 does not say which, and the second is unmeasured for both hosts.

**P4. Idempotency: v20 names a new key and misses the existing mechanism.** Lane 2a line 397 says every mutating
tool takes an idempotency key mapped to `command_id`. No CLI verb accepts a command id: `ask`'s flags are
`body-file, body-stdin, to, about, channel, until, wait`. The CLI already has a durable ambiguous-retry recovery
for signals. `pendingSignalCommandId` hashes (workspace, command, principal) and persists the id for 1 h
(`src/cloud/pending-command.ts:23, 180-240`). A profile credential is a JSON artifact and is `durable: true`
(`agent-credential-input.ts:210`), so it applies to profile-backed `ask/note/reply/working_on`
(`src/cli.ts:3522-3558`). The internal write retry replays one id (`command-client.ts:1339-1364`). What it does NOT
cover is the MCP case: the pending entry is cleared on success (`pending-command.ts:276`). So a result lost after
success, or a cancelled `ask --wait`, then a host retry, posts twice. Lane 2 must (a) add a `requestId`/`command-id`
input (a handler change; lane 1's "no body rewrite" bound only the mechanical commit), (b) rule which id wins when
both the key and the pending entry exist, and (c) name `pending-command.ts` so the mechanism is copied from the code
(§7's own rule).

**P5. Lane 3's 2a fix breaks older clients and does not close the case its control starts from.** This is lane 3,
not lane 2, but it would ship as written.
- `readAgentProfile` accepts exactly six keys, or those six plus `workspace_name` (`agent-profile.ts:148-151`). A
  profile that carries `token_id` is "damaged. Run setup again." to every older cswarm. The 0.1.72 record says
  other seats' long-lived processes stay on older versions until restarted. A hook or listener on 0.1.72 would get a
  false remedy.
- "A profile WITHOUT a `token_id` keeps today's behaviour" (line 773-774). But the realistic first reconnect writes
  over a `setup`-written profile, which has no `token_id`. So §4's control, which starts from "an ACCEPTED old
  profile", passes or fails depending on which old profile the implementer picks, and v20 does not say.
- The hazard is also misstated. `saveAgentProfile` accepts an old profile only when url, workspace and principal are
  equal (`:192-197`). `credential_file` is forced to `dirname/credential.json` (`:157`). So the stale profile and the
  new credential are the same seat, workspace and host. Only `anon_key`/`workspace_name` can differ. "check
  authenticates the NEW token against the OLD profile's url and workspace" (line 769-770) describes values that are
  identical by construction. The Strategist's literal condition still needs the refusal. But the spec should state
  that no wrong-seat outcome exists, rather than implying one.
- The step-4 discriminator ("credential present with the profile missing is a connect interrupted partway", lines
  786-790) also matches a `setup` killed between the same two writes, because `setup` uses the same
  `saveAgentProfile` order (`:199-200`). So it gives a `setup` user the connect remedy, which is the defect row 84
  says it fixes. And in the window the control tests, the profile is not missing: the refusal comes from the new
  `token_id` mismatch. v20 does not name that code or give it a remedy constant ("three states" is not enumerated).

## B. Findings: stale or false against origin/main

| v20 claim | current fact |
|---|---|
| Line 3 "Nothing here is built." | Lane 1 shipped in 0.1.72: `AGENT_COMMANDS` (`src/cli.ts:9394`) with `tool`, `reason`, `mutates`, `transports`, `profile`, `hostSessionId`, `visible`, `bootstrap`, `variants`/`select`; `agentToolsForTransport` (`:9586`); gates `tests/p1-cli/command-table-gates.test.ts`, `command-dispatch-baseline.test.ts`. |
| §2 copy table (lines 89-103), `CHANNEL_SUBCOMMANDS (src/cli.ts:8734)`, sites `:9235`, `:9262-9274`, `:714` | The `if` chains are gone. `CHANNEL_SUBCOMMAND_NAMES` is derived from `AGENT_COMMANDS.channel` (`:9574`). JSON-error and host-session behaviour are entry data (`errorMode`, `workspaceErrorJson`, `hostSessionId`). The `onboarding-cli.ts` dispatcher is gone (`runOnboardingCommand` is only a trace label). §2/§3 lane 1 still read as future work. |
| Lane 2 tool list (lines 373-375): `working-on`, `brain_put`, `file_put`, no `resume` | Shipped tools (16): `ask brain_get brain_ls channel_ls check feed file_get file_ls inbox members note receipt reply resume whoami working_on`. The name is `working_on`. `resume` IS a tool on both transports. `brain_put`/`file_put` are `tool: null` (`CLI_ONLY_UNTIL_ITEM_L_REASON_MARKER`). v20's list also contradicts its own lane 2a. |
| Lane 3 item 5 / §7 "`mcp connect --profile` is a write path and the entry shape has no mode for it" (lines 888-895, 1259) | Precedent is shipped: `setup` writes to `--profile` and is `NATIVE_PROFILE` (`:9400-9409`). `expandAgentProfile` returns before reading for `native` (`:759`). `mcp` = `native`/`keep`. `mcp connect` = `native`, like `setup`. |
| Lane 3 item 6 (lines 896-902): `--profile` throws at `cli.ts:707-708`, is deleted at `714-721` | Now `profile`/`hostSessionId` entry data (`expandAgentProfile`, `:751-774`). The two-change trap is now one table row. |
| Lane 2a/2 retry citations: `agent-check.ts:199-202`, `:139-140`, `:142-149`; `renewal.ts:841, 866-870, 915-922, 753-814`; `cli.ts:3163, 8065-8093, 8186-8194, 4631-4679`; `index.ts:603, 7768-7769, 9614-9652, 3486-3490, 3556`; "9,477-line file" | The behaviour still holds. The lines moved: cursor after `present` `agent-check.ts:223-224`; `openProfileCredential` `:161`; `due()` no-store `renewal.ts:851-853`; `bearer()` `:878`; lock `:948`; `COMMAND_ID_RE = H0_REQUEST_ID_RE` `index.ts:654`; `getUser`/`getClaims` `:11277-11278`; no-secret replay comment `:3677`; `predecessor_token_id IS NOT NULL` `:3743`; `uploadNamedFile` `cli.ts:8223`; `wx` `files.ts:463`; `reportRenderedBroadcasts` `cli.ts:4671, 4713, 4806, 5013, 6865`; `index.ts` is 12,004 lines. |
| Addendum lines 9-13: the VPS "HezLead provisions — CommonSwarm's first service on that box and the entry point for the later API migration" | Production IS the box (`yulan-vps-1`) since 2026-09-20. The API migration happened. H0 already serves agents there (`supabase/functions/h0/`, live release `30ba33f9`). |
| Lines 638-642: H1's long-stream caveat "comes from the 150 s Edge idle timeout, which a VPS does not have" | False on the box. It runs the same edge runtime with a **150 s wall-clock limit per worker, a 150 s response-idle limit, four workers, and 96 MiB each** (`deploy/edge-runtime/README.md:39-46`). H0 measured one waiting long-poll for the whole deployment (`H0_MAX_CONCURRENT_WAITS = 1`, `src/h0/verbs.ts:97`). A remote MCP endpoint in that runtime inherits these limits. |
| §6 lines 1110-1112: "the Hetzner box is not provisioned, no endpoint exists, and no host has been observed authenticating against one" | The box is provisioned and is production. H0 endpoints are live. Agents authenticate with seat bearers there. `deploy/RELEASE-TO-BOX.md` is the release procedure. |
| Lines 644-647: "in-process reuse needs a refactor while an HTTP self-call needs none" | H0 already calls the command handler in-process (`supabase/functions/h0/forward.ts:1`, "H0's in-process request adapter to the command edge"). Lane 2b should copy that mechanism. |
| v20 never mentions H0 | `src/h0/verbs.ts:20-22` says "item H lane 1 folds this table into it". Lane 1 shipped **without** folding it. There are now two agent-verb catalogs, and the comment is false. H0 also has a live join credential with `attemptId` seat recovery (`verbs.ts:117-126`), which bears directly on lane 3's connect code and item M. v20 must say whether connect reuses H0 `register` or why not. |
| §5 item 4 / §6 "credential expiry mid-session is undefined" | 0.1.73 defined two renewal modes. Listener mode uses a confirmation window, and one-shot `bearer()` gives D-004/D-011 sentences (`docs/evidence/2026-09-22-listener-outage/LANE.md:340, 376-380`). The typed codes are exported (`COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES`, `src/cloud/signals.ts:2373`). Lane 2 can choose from these, so item 4 can now be decided. |
| Shipped `check` and `resume` have `transports: ALL_TRANSPORTS` | This contradicts lane 2b constraint 3 (no cross-call state on remote). `check`'s cursor is a local file beside the profile (`checkStatePath`). That is a lane 2b fix, not a lane 2 fix, but the table is wrong today. |

## C. Findings: RIGOUR (internal consistency of v20)

- R1. The retired recovery text still reads as live. Lines 729-737 say "so it is DECIDED, not open" and "**The decided
  shape:**" under the "(RETIRED 2026-09-15)" bullet. §7 line 1260-1263 says recovery "is only safe if one
  destination-scoped lock spans redemption and the local commit". That contradicts step 5 (lines 797-803, "H adds
  no lock of its own"). This is the sweep miss §7 rules 4/13 describe, for the sixth version.
- R2. Mangled text, the class of §7 rule 19. Line 1261-1262 repeats the parenthetical "(also later broken; four shapes
  failed in total and recovery moved to item M)" twice in one sentence. Rule 12 ends with a fragment that has no
  start ("survival of everything in it you meant to keep", line 1320). Rules 11, 14, 19 and 22 are one-liners,
  because their explanations were concatenated into rule 25 (lines 1356-1367).
- R3. Line 810-815: unbind "must ALSO REVOKE ... (see the crash windows above)". The crash-window text was retired.
  The reference points at nothing.
- R4. §7 table rows are out of order (…80, 82-86, 81, 77), and §5 numbers run 1,2,3,4,5a,5,6,7a,7,8,9,10. Cosmetic,
  but this is the positional-claim class the count checker cannot see.
- R5. v20 answers each v19 failure it names (rows 82-86) in text. The answers to 82 and 84 introduce the P5 defects.
  86's corrected citation (`agent-check.ts:142-149`) is already stale on main (`:161-172`).

## D. Build lane 2 now?

**Yes, with the decisions below written into a short lane-2 brief that the Strategist rules.** No §5 item that
blocks lane 2 depends on lanes 2b, 3, L or M. Each one can be decided from the code on main:

1. **Transport of results** (P2): use `checkAgentMessages` in-process for `check`, and a child process
   `cswarm <verb> --profile P [--host-session-id H] --json` for each other tool. Pass the body on the child's stdin.
   The server's stdout carries JSON-RPC only. No module-level state is shared between calls.
2. **Principal scope** (P3): release 1 accepts unmanaged principals, plus managed principals only when the operator
   passes `--host-session-id` in the install line. Otherwise the server refuses at start with a typed code. Never
   default to `"manual"` silently for a managed principal.
3. **Tool set for release 1**: `whoami`, `check`, `ask`, `note`, `reply`, `working_on`, `members`, plus `brain_ls`
   and `brain_get` if the result cap (item 1) is ruled. Out of release 1: `file_get` (a host write with a
   model-chosen path), `feed`/`inbox` (their `signals_seen` receipts are recorded before the host has the result),
   `resume`, `receipt`, `channel_ls`, `file_ls`. Nothing on the done-test path needs them. `check`'s `message_id`
   variant stays in, to read full text. The `hook` variant stays out.
4. **Argument schemas** (P1): an allow-list per tool, taken from H0's vocabulary:
   - `ask`/`note`: `{body: string (required), to?: string, about?: string, channel?: string, until?: string,
     request_id: string ^[A-Za-z0-9_-]{8,72}$ (required)}`
   - `reply`: `{signal_id (required), body (required), request_id (required)}`
   - `working_on`: `{body, about?, channel?, until?, request_id}`
   - `check`: `{full?: boolean, message_id?: uuid}`
   - `whoami`, `members`: `{}`
   - `brain_ls`: `{}`; `brain_get`: `{topic: string, version?: string}`
   - All schemas have `additionalProperties: false`, and the server validates them (the SDK does not, per
     `agent-channel.ts:176`). The deny-set gate and a positive control come from P1.
5. **Result shapes**: each tool declares its own. `whoami` returns `{principal_id, name, workspace_id,
   workspace_name}` and no grant or owner fields. `check` returns `AgentCheckResult` with `full_text_command` and
   `next_action` rewritten to tool names, because a shell command in a result breaks "MCP tools only" and exposes the
   profile path. Signal posts return `{signal_id, created_at, replayed}`. Results are capped at a stated byte limit,
   with `truncated: true`.
6. **Retry contract** (§5 item 9, `check`): `present` resolves when the SDK has written the response. A result
   lost after that is recoverable through `check {message_id}` from the local cache
   (`cachedAgentMessage`, `agent-check.ts:231`), and the tool description says so.
7. **Idempotency** (P4): add `--request-id` to `ask/note/reply/working-on`. It takes priority over the pending-intent
   id. A cancelled mutating tool returns `{outcome: "unknown", retry_with_same_request_id: true}`.
8. **Credential and error mapping** (§5 item 4): use one-shot renewal for each call, through the file store and
   `withLock`. Map by class or code, never by message (D-053):
   - `AgentSetupError.code` → `isError` with `{code, message, next_step}`.
   - `CommandHttpError` status and slug → `isError` with the server's sentence.
   - D-004 expiry, D-011 refusal, `RenewalUpgradeRequiredError` (426), `renewal_unsupported` → `isError` with
     their existing sentences. The server keeps running and never selects another profile.
   - Schema violations → JSON-RPC `-32602`.
   - Do not map `delivery_unavailable` as a credential loss (LANE.md:25).
9. **The `mcp` table row**: `tool: null` (bootstrap), `profile: "native"`, `hostSessionId: "keep"`,
   `transports: STDIO_ONLY`, `visible: true`, with a help line.

**Smallest first release that meets §4:** §4 requires "a connect code", so lane 2 alone does not meet it. Release 1 =
lane 2 above, with bootstrap by the existing `cswarm setup --connection-file`, which is the same kind of CLI exception
lane 3 already allows. It passes read inbox, ask and reply on Claude Code and Codex. It is released on npm, with a
production control for each tool. §4 is fully met only when lane 3 lands, **or** when the Strategist rules that
connection-file bootstrap (or H0 `register` run by the operator) satisfies "connect code". That ruling should be
asked now, because it decides whether lane 3 is on H's critical path. Wait for later: 2b (remote), lane 4 (wake),
item L (`file_put`/`brain_put`/attachments), item M (connect crash recovery), `feed`/`inbox`/`file_get`/`resume` as
tools, and folding `H0_VERBS` into `AGENT_COMMANDS`.

## E. Safety summary (brief item 5)

- A token can reach a model turn through `body-file` in the shipped schema (P1). This is the highest-severity finding.
- A token in argv: the child-process design must pass only the profile path in argv, never `--agent-token-*`. Bodies
  go through stdin, not argv (the memory note on large argv also applies).
- Logs: handler stderr goes to host MCP logs. I found no token printed to stderr on these paths. Not proven for every
  error path.
- A mutation posted twice: the internal retry is safe (one id). Host retry after a lost result, and a cancelled
  `ask --wait`, are not safe (P4).

Not established by this arm: no run of any MCP host; which MCP revision Claude Code and Codex speak; whether
Claude Code's install line can fix a session id; whether an H0-registered seat can use CLI `check` reads (the fence
refuses only `claim_agent_inbox`); every stderr path.

Verdict reason: v20 is not safe to build from as written. Its lane-2 text, together with the shipped lane-1 schema,
exposes credential and file-read arguments to a model (P1). It gives no result mechanism (P2) and no source for the
required host-session id (P3). Its box and H0 statements are false against main. Lane 2 can start at once from
section D, without another full spec round, if the Strategist rules those nine decisions.

VERDICT: FAIL
