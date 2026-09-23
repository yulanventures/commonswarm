I'll review the v20 MCP design spec against current `origin/main` only: no file changes, no production contact, and no other models. First I'll load the spec and locate the code it cites.The spec is v20 at `c72f0916` (1,369 lines). Current `origin/main` is `1985b063`. Next I’ll check whether v20’s v19 answers hold, and whether its citations still match the shipped command table, renewal, and profile code.v20 (`spec/mcp-server` at `c72f0916`) does not close the failure an arm reproduced, and it is not a safe build input against `origin/main` (`1985b063`, cswarm 0.1.73). Lane 1 has already shipped. The connect fix specified for that reproduction still accepts the reproduced state.

## v19 answers

| v19 defect | What v20 does | Holds? |
|---|---|---|
| 82. `check` returned `checked: true` on a complete stale profile plus a new credential | §3 lane 3 step 2a (lines 771–776): put `token_id` on the profile; `readProfileCredential` refuses on mismatch; a profile with no `token_id` keeps today’s behaviour | No |
| 83. An empty directory passes the negative control | §4 lines 969–982: start from an accepted old profile, kill between the two renames, prove the fail point | The test is specified. The fix in 82 does not pass it |
| 84. One remedy sentence is false for `setup` | Lines 783–790: split `profile_missing` by whether `credential.json` exists | Only for a missing profile. The reproduced state is both files present |
| 85. A duplicated English sentence passes | Lines 791–796: the test imports the constant | The stale-profile refusal has no constant to import |
| 86. Cited the setup path for `check` | Lines 777–780: refusal belongs in `readProfileCredential`; `AgentCredentialSession.open` only loads local state | The function names are right. The line numbers are not (below) |

The reproduced window is still open, and the spec’s own rules keep it open. `saveAgentProfile` writes `credential.json`, then the profile (`src/cloud/agent-profile.ts:191–200`). v20 step 1 (lines 759–760) keeps that order. Kill after the credential rename and the old profile is still the file on disk. Today’s profiles have no `token_id`: the accepted key sets are exactly the six required keys, or those six plus `workspace_name` (`agent-profile.ts:146–151`). Step 2a says a profile without `token_id` keeps today’s behaviour, and `readProfileCredential` compares only `principalId` (`agent-profile.ts:165–170`). The same principal matches, and `check` uses the new bearer against the old profile’s url and workspace (`agent-check.ts:161–171`). That is `checked: true`.

Those two requirements cannot both hold. Exempting profiles that lack `token_id` is what leaves current `setup` profiles working, and it is also the §4 start state (`agent-profile.ts:192–197` admits that profile). Requiring a match breaks every current `setup` profile, because the credential artifact already requires `token_id` (`src/cloud/agent-credential-input.ts:53–60`) and the profile does not store it. Adding `token_id` to the written JSON without extending those exact sets makes `readAgentProfile` return `profile_invalid` (“damaged. Run setup again.”), which is the false remedy defect 84.

Elsewhere the document still asserts the withdrawn recovery. Lines 719–735 say the shape “is DECIDED, not open” and that §5 item 7a is a design blocker. Lines 737–740 and §5 item 7a (lines 1046–1053) move recovery to item M. §7 lines 1260–1265 still say the third shape “stuck” and is safe only if one lock spans redemption and the local commit. Step 5 (lines 797–803) says H adds no lock. Lines 907–909 say “Four remedies” and then “All five are retired.”

## Stale or false against `origin/main`

Lane 1 is on main. `AGENT_COMMANDS` is the dispatcher (`src/cli.ts:9394`), `main` does one lookup (`cli.ts:9658–9668`), and `agentToolsForTransport` (`cli.ts:9586–9600`) already builds a tool list. Header line 3, “Nothing here is built,” is false. The lane 1 snippet (`select` returns a handler, lines 164–181) is not the shipped shape: shipped `select` returns a variant id (`cli.ts:9154–9156`, `9610–9619`). Rebuilding from that snippet would replace a table that already records `profile`, `hostSessionId`, `mutates`, `transports`, and `tool: null` with reasons.

Production is the Hetzner box (stack, edge, site, H0). Lines 10–12 (“first service on that box”) and §6 lines 1110–1112 (“the Hetzner box is not provisioned”) are false. `supabase/functions/command/index.ts` is 12,004 lines, not 9,477 (line 645). No MCP endpoint exists. H0 is live: `POST h0/register|ask|note|reply|working-on` and `POST h0/poll|ack`. The spec never mentions it. An H0 seat’s `claim_agent_inbox` is refused `h0_seat_uses_poll`. CLI `inbox` and `check` use the read edge, not claim.

Renewal for a normal command is still the v20 rule. `listenerMode` defaults false (`cli.ts:3108`). `bearer()` renews when due (`renewal.ts:878–881`, called from `commandWorkspaceAndCredential` at `cli.ts:3201–3202`). No store means no renewal (`renewal.ts:841` and `853`; the sentence is at line 851). The lock still spans read-decide-write (`renewal.ts:948`). 0.1.73 changed the listener, not this path: `listenerMode` throws `RenewalRetryError` on a retryable renewal failure (`renewal.ts:905–915`), and a listener stops for credential loss only after a confirmation window. Command-edge `forbidden` is not that signal. A lost renewal answer is still `successor_not_recoverable` (`renewal.ts:997–1021`). The server can still discard an unused stranded successor and mint another (`command/index.ts:9391–9456`). v20’s “replay is not uniform” claim holds. Its line `7753–7755` does not: that region is grant-resume.

`check` is no longer “cursor written after `present()` at `agent-check.ts:199–202`.” Lines 199–202 build a message. The body cache is written before `present`, and the cursor is written after it (`agent-check.ts:216–224`). A `present()` that resolves and then a lost MCP result still skips those messages. A throw inside `present` does not advance the cursor.

Citations that still name the right code: `COMMAND_ID` primary key `supabase/migrations/20260723000001_p1_schema.sql:368–377`; `requestHash` over the whole command `src/protocol/idempotency.ts:41–43`; `H0_REQUEST_ID_RE` is still `^[A-Za-z0-9_-]{8,72}$` (`src/h0/verbs.ts:106`), and `COMMAND_ID_RE` aliases it (`command/index.ts:654`); `command_id: newCommandId()` in seen-receipts (`src/cloud/agent-signal-receipts.ts:68`); wake sentences at `LIVE-CONTROLS.md:19`, `RESULTS.md:52`, and `onboarding-cli.ts:52`; `agent-channel.ts` is still 352 lines and still one receipt tool. Upload expiry is still 7200 seconds and the pending slot is still three hours (`file-artifacts.ts:765` and `:564`).

Citations that now point at other code:

| Spec | What it claims | What that line is now |
|---|---|---|
| §2 `cli.ts:8734` | `CHANNEL_SUBCOMMANDS` | A channel-name comment. Names are `CHANNEL_SUBCOMMAND_NAMES` at `cli.ts:9574` |
| §2 `cli.ts:9235`, `9262–9274`, `714` | argv verb lists and host-session keep | `commandFlags`, `traced()`, and `Arguments.push`. Host-session drop is `cli.ts:765–772` |
| §2 `cli.ts:707` | `AGENT_PROFILE_COMMANDS.includes` | Unknown-option throw. The list is derived at `cli.ts:9565–9572` |
| Lane 1 `cli.ts:8963–8975`, `8977` | Meta-commands, onboarding returns first | Meta-commands are `cli.ts:9644–9656` (the four conditions are still true). Dispatch is `9658` |
| Lane 2a `command/index.ts:7768–7769`, `7814` | 409 conflict and replay | A grant-resume 200. Conflict and replay for this ledger are `9406–9407` and `9452–9454` |
| Lane 2a `index.ts:603` | `COMMAND_ID_RE` | A reducer method. The regex is line 654 |
| Lane 2a `index.ts:7753–7755` | Renew self-heal gate | Grant resume. The gate is `9391–9456` |
| Lane 2b `index.ts:9614–9652` | `auth.getUser` / `getClaims` | An idempotency insert. User JWT auth is `11277–11278` |
| Lane 3 `index.ts:3486–3490` | Replay stores no secret | Reducer context. The comment is `9375–9379` |
| Lane 2a `cli.ts:8186–8194` | `file get` uses `wx` | Human file listing. `runFileGet` calls `writeDestination` at `cli.ts:8379–8381`; `wx` is `src/cloud/files.ts:456–463` |
| Lane 2a `cli.ts:8065–8093`, `8421` | `file put` / `brain put` phases | `uploadNamedFile` is `cli.ts:8223`; ids at `8258–8259`. `runBrainPut` is `8577` |
| Lane 2a `cli.ts:3878` | `attach` is a flag | Still a flag, at `postSignalAllowedFlags` `cli.ts:3917`. The ask/note/reply tool flags omit it (`9519–9521`) |
| Lane 3 `storage.ts:360–370` | File sync, rename, no directory sync | `writeSecureJsonFile` is `storage.ts:449–465`. Same behaviour, wrong lines. Mtime steal is `storage.ts:402`, and a dead local pid can be reclaimed earlier (`354–412`) |
| Lane 3 `agent-check.ts:142–149` | `check`’s first server reads | `assertProfileIdentity` starts at 108. The reads are `164–171`, after `openProfileCredential` at 161 |

The shipped stdio tool names (`tool !== null`) are: `check`, `whoami`, `resume`, `channel_ls`, `file_ls`, `file_get`, `brain_ls`, `brain_get`, `members`, `working_on`, `note`, `ask`, `reply`, `receipt`, `feed`, `inbox`. v20’s prose list (lines 373–375) still says `working-on`, `brain_put`, and `file_put`. The table already marks `file put` and `brain put` `tool: null` for item L. `resume` is a tool the prose list does not name. `check.transports` is `stdio` and `http` (`cli.ts:9412`) even though `check` writes `check.json` beside the profile.

## Lane 2

Not specified well enough to build. §5 items that touch it:

| §5 | Spec says it blocks | Settled? |
|---|---|---|
| 1 | Result limits for file and brain | No. CLI caps exist (`SIGNAL_BODY_MAX` is 8000 at `cli.ts:1230`; about is 500 at `cli.ts:3398`). No MCP result schema |
| 4 | Credential expiry on stdio | Decidable from `renewal.ts`, not written as tool copy. Unexpired unknown renewal warns and continues (`917–925`). Expired, revoked, suspended, and reauthorisation throw. No tool may return `bearer` |
| 8 | Host retries with the same arguments | Not in this repo. Unmeasured |
| 9 | Retry contract for `check`, `file_get`, `feed`/`inbox` | Behaviour is in the code. v20 sets no contract (§7 lines 1254–1255) |
| 2, 3 | Upload resume | Item L. `file_put` and `brain_put` are already `tool: null` |
| 5, 5a, 6, 10 | Remote revision, remote renewal sentence, header token, remote connect | Remote only |
| 7 | Hook `session_id` | Post-setup only |
| 7a | Connect crash recovery | Item M. The lane 3 prose still calls it a blocker |

`agentToolsForTransport` is not an MCP schema. For every `expand` or `native` tool it advertises `agent-token-file`, `agent-token-stdin`, `url`, `anon-key`, `workspace-id`, `profile`, and `host-session-id` (`cli.ts:9358–9361`, `9218–9223`). `inbox` also advertises `follow`, `ndjson`, and `notify`. `check` advertises `hook`. `ask` advertises `wait`. Publishing that list puts a credential in a tool argument.

The handlers are `(args) => Promise<void>` and write stdout (`runPostSignal` around `cli.ts:3804`). On an MCP stdio process that is the JSON-RPC stream. They also cannot see an idempotency key. `postSignalCommand` (`cli.ts:3505–3556`) stores a pending id hashed from the command body and deletes it on success (`src/cloud/pending-command.ts:255–278`). A host retry after a lost success mints a new id. `ThinCommandClient.sendSignal` already keeps one `command_id` across its three internal attempts (`command-client.ts:1268–1269` and `1364–1365`, `SIGNAL_WRITE_MAX_ATTEMPTS` at line 388). The tool key has to be passed there as `commandId`. Wrapping `runPostSignal` drops it.

A lane 2 implementation has to decide all of the following. v20 does not.

Process arguments, not tool arguments: `--profile <path>` and, for a managed principal, `--host-session-id`. One workspace. `listenerMode` false. Auth is `readAgentProfile` plus `openProfileCredential`. Refuse `url`, `anon-key`, `agent-token-file`, `agent-token-stdin`, `workspace-id`, and `session-context` on every tool.

Do not publish the generated list. First stdio set, if connect is out of scope: `inbox` (read variant only), `ask`, `reply`. `working_on` and `note` can share the ask path once the key is wired. Leave out `check`, `file_get`, `feed`, `follow`, `notify`, `hook`, `wait`, `resume`, and anything `tool: null`.

Arguments:

- `inbox`: optional `limit`, `since`, `kind`, `about`, `channel`, `include_stale`. No idempotency key. No `follow`, `notify`, `ndjson`, `wait`.
- `ask`: required `body` (1..`SIGNAL_BODY_MAX`), required `idempotency_key` matching `H0_REQUEST_ID_RE`, optional `to`, `about` (max 500), `channel`, `until`. No `attach`, `wait`, `body_file`, `body_stdin`.
- `reply`: required `signal_id`, required `body`, required `idempotency_key`, optional `thread`, `broadcast_to_channel`, `until`. No `attach`.

`idempotency_key` is `command_id` on one `sendSignal`. The description says a retry sends the same key. §5 item 8 is still unmeasured, so this is necessary and not proof of exactly-once.

Results, and nothing else (no grant, no `credential_metadata_match`, no bearer, no profile path, no `full_text_command`):

- `ask` and `reply`: `signal_id`, `kind`, `created_at`, `workspace_id`, `in_reply_to`, `channel_id`.
- `inbox`: `id`, `from`, `from_kind`, `kind`, `body`, `created_at`, `in_reply_to`, `about`, `attachment_count` for each row.

Errors, matched on class, with `isError: true` and that class’s sentence:

- `AgentSetupError`, `UsageError`: the sentence. Do not substitute another profile.
- `CommandHttpError` 409 `command_id_conflict`: stop. Do not mint a new key.
- `CommandTransportError`, or an abort after the send has started: outcome unknown. Retry the same key. Never “not done.”
- `RenewalRevoked`, `RenewalReauthorisationRequired`, `RenewalSuspended`: the renewal sentence. The process stays up. The bearer stays out of the result.

`inbox` must not call `reportRenderedBroadcasts` until item 9 has a contract. That helper posts `signals_seen` with a fresh id per batch before the caller returns (`agent-signal-receipts.ts:32–35` and `:68`). Directed rows are filtered out; broadcasts are not.

## Smallest release that meets §4

§4 needs a connect code, a Claude session and a Codex session, inbox, ask, reply, the token absent from the model turn, npm, a production control per tool, and the negative `check` control. v20 cannot meet that. The connect fix fails the control it adds.

What can be the first slice is stdio `cswarm mcp` over a profile `cswarm setup` already wrote, with `inbox`, `ask`, and `reply` under the decisions above. The §4 negative control stays a CLI `cswarm check` against a profile this server does not create.

Wait: lane 1 (shipped), `check` / `feed` / `file_get` as tools, `follow` / `notify` / `wait` / `hook`, `resume`, `whoami` until its fields are an allowlist (`renewal_grant` includes `token_id` and device ids, `src/cloud/renewal-grants.ts:6–21`), file and brain writes (item L), connect crash recovery (item M), the remote endpoint (lane 2b, including “do not renew”; the typed next step is still unwritten), wake (lane 4), and hook attestation (§5 item 7). Connect itself waits until a design passes the §4 control on a profile that has no `token_id`.

## Unsafe if built as written

- A model can pass `agent-token-stdin` or `agent-token-file` if the tool schema is the table’s `argumentSchema`. That is the token in a tool call.
- `runPostSignal` clears its pending command id on success, so a host retry posts a second ask, note, reply, or working-on. Cancellation reported as “not done” does the same if the next key is new. `sendSignal`’s in-process retries are safe only because they reuse one id.
- `inbox --follow` and `check --hook` are on the generated schema. `follow` holds the stdio process.
- Connect as specified in steps 1 and 2a leaves `check` accepting the new bearer with the old profile.
- `runWhoami`’s object includes `renewal_grant` and `credential_metadata_match` (`cli.ts:4392–4404`). Forwarding it whole puts grant and token ids in the model turn. The bearer itself is not in that object, and `resumeJson` (`src/resume.ts:547–580`) does not contain the token either.

Build lane 2 now: no. It needs the process-versus-tool argument split, the three-tool list above, those argument and result schemas, the error map, `idempotency_key` passed once into `sendSignal` as `command_id`, stdout left to the MCP transport, and `reportRenderedBroadcasts` left out. Connect is not part of that slice; v20’s fail-closed steps do not pass §4.

VERDICT: FAIL
