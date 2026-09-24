I'll review lane 2 at `c32abeb5` against the round-3 findings and the fold-4 rulings, without changing files. First I'll read the prior review, the lead's rulings, and the lane record.The tip is `c32abeb5`, one commit past `d7c17124`. Next I’ll read Fold 4 in `LANE.md` and the fold diff against the five round-3 findings.The fold is five files. I’ll read the error map, channel schema, and the tests that claim to pin each fix, then re-derive the edge codes.The sentence table and channel rule are in place. I’ll now trace every `post_signal` and read refusal the edge can actually return, and check the tests against those paths.The five round-3 failures are fixed at `c32abeb5`, and the fold does not add a new false sentence or a CLI behavior change. No PRODUCTION or RIGOUR findings.

## Post-path sentences

A validated MCP post sends `post_signal` as `ask`, `note`, `working-on`, or a private `note` reply. It may send `channel` and `until_ms`. It does not send `thread_root_id`, `to[]`, or `attachments`, so thread and attachment codes are not on this path. A 5xx (`internal_error`, `temporarily_unavailable`) is retried by `ThinCommandClient` and then becomes `{outcome: "unknown"}` in `src/mcp/server.ts`.

| Code | Status | When | Sentence and next step |
|---|---|---|---|
| `unauthenticated` | 401 | Token missing or not live | True. A person must restore access. |
| `session_proof_missing` | 401 | Managed principal, no proof headers | True. "The current host session was refused by the service." Restart with the current host session. |
| `session_proof_invalid` | 401 | Bad proof, missing session row, or key mismatch | Same owned sentence and restart step. |
| `session_expired` | 401 | Managed session not live | Same. |
| `session_conflict` | 409 | Session id or generation mismatch | Same. Status 409. |
| `forbidden` | 403 | Reply not eligible, recipient not live, missing scope, revocation, or route | True. Causes, not permissions. Next step is the existing check-then-restore step. |
| `invalid_request` | 400 | Shape or sanitizer refusal | True. Fix the argument. |
| `upgrade_required` | 426 | Client older than `min_client_version` | True. A person must act. |
| `command_id_conflict` | 409 | Same id, different hash or route | True. Stop and keep the id. |
| `rate_limited` | 429 | Credential bucket (120/hour) or workspace bucket (1000/hour), both `date_trunc('hour')` | True. The window resets at the next hour. Wait, then retry the same `request_id`. The command client stores no `resets_at`, so there is no `retry_after`. |
| `channel_not_found` | 404 | Slug absent in the workspace | True. Fix `channel`. |
| `channel_archived` | 409 | Slug archived | True. Fix `channel`. |
| `payload_too_large` | 413 | Raw body over 128 KiB | Not reachable after MCP validation (body ≤ 8,000, about ≤ 500). The owned sentence would be true if it were. |

`enforceAgentSessionProof` returns only those four session codes for `post_signal`. `session_retired`, `session_not_managed`, `session_already_managed`, `session_leases_live`, and `delivery_not_surfaced` are not on this path.

The `forbidden` sentence matches the edge. `resolveSignalWriteTarget` returns null, and the handler answers 403 `{error: "forbidden"}`, when the referenced row is missing, not an ask or note, already expired (`until > statement_timestamp()`), or not addressed to the caller (`supabase/functions/command/index.ts:8476` and `:9676`). A dead recipient takes the same null. A missing `post_signal` scope, revocation, or a failed route is the same bare code (`:9242`, `:9041`, `:9024`). The reply clause is a cause of refusal. The CLI states the same cause at `src/cli.ts:3924`.

## Read path

`whoami`, `members`, and fresh `check` call the read edge. That function does not run the session fence. Its reachable refusals are 401 `unauthenticated`, 403 `forbidden` when the agent is revoked, and 500 `internal_error`.

| Code on the wire | What the model sees | Sentence and next step |
|---|---|---|
| 401 `unauthenticated`, 403 `forbidden`, 426 `upgrade_required` | `read_refused` | True. "The service refused this read." A person must restore access. |
| 401/409 session-proof codes, if a body carries one | The four owned codes | True. Host-session restart, not the access step. |
| 500 `internal_error` | `read_failed` | True. Retry. |

`src/mcp/errors.ts:127` checks the session-proof list before the 401/403/426 collapse, so a session 401 is not rewritten as `read_refused`. A read `forbidden` stays `read_refused` and does not inherit the post sentence.

## The five points

1. **`forbidden`.** `src/mcp/errors.ts:59` is the lead's cause sentence, with `CHECK_ACCESS` unchanged. `tests/p1-cli/mcp-stdio.test.ts:447` pins the full payload for `ask`, `note`, `reply`, and `working_on`. Restoring the old wording fails that `deepEqual`.

2. **Session codes.** `AGENT_SESSION_PROOF_REFUSAL_CODES` in `src/cloud/session-wire.ts:44` is the list the fence returns. The sentence table is built from that array (`src/mcp/errors.ts:66`). `tests/p1-cli/mcp-stdio.test.ts:405` fails if an entry or the restart step is missing. Lines 469 and 485 require the post and read payloads. A direct `mapMcpError` of each code, including a producer string `cswarm --profile /tmp`, returns only the owned sentence.

3. **Channel schema.** `not.enum` is the same array `channelSlugProblem` reads (`RESERVED_CHANNEL_SLUGS`, identity checked). `validateMcpArguments` applies type, `minLength`, `maxLength`, `pattern`, and `not.enum` from that schema object and does not call `channelSlugProblem` (`src/mcp/tools.ts:49`). `all-signals` matches the pattern and is rejected as `Invalid argument: channel.`; `team-updates` is returned unchanged; `TEAM-UPDATES` fails the pattern. `tests/p1-cli/mcp-stdio.test.ts:700` requires the advertised enum and `-32602`. Emptying the enum fails that assertion, and with only the schema check the call would also stop returning `-32602`.

4. **Partial page.** The six bodies are 110 characters, under the 4,000-character library budget, so the library keeps all six. With a 31,000-character workspace name, `capFreshCheck` shows 4 of 6 (32,626 bytes, cap 32,768). The uncapped page is 33,314 bytes, so returning every library message makes `capMcpResult` drop `messages` and `tests/p1-cli/mcp-stdio.test.ts:627` fails. The later pages still require the six ids in order and then an empty page (`:636`).

5. **`LANE.md`.** Row 6 quotes the retired cancellation wording and marks it superseded by Fold 1 (`docs/evidence/2026-09-23-mcp-lane2/LANE.md:14`). R9 says validation does not normalize and the 80-character recipient bound is schema-only (`:63`). The document test pins both (`tests/p1-cli/mcp-stdio.test.ts:751`). Removing the inline marker fails it. The R10 rows match the baseline: `policy.host-session.mcp.keep` and every `selected-error.mcp.*` row exit 1 with `too many positional arguments`; the three startup rows are `mcp_start_failed`, `profile_missing`, and `host_session_invalid`. The focused assertion names them in a comment, as Fold 4 required, and the baseline count file is 1,261.

## Other checks

The fold diff for `src/cli.ts`, `src/cloud/signals.ts`, and `src/cloud/agent-check.ts` is empty. `session-wire.ts` only adds the exported code list. CLI commands do not import it.

Every owned sentence and next step fails the lane's own scan for `cswarm`, a `--` flag, or a path. The new restart and wait steps do not carry a shell command, a producer message, or a token. `request_id` in the rate-limit step is the tool argument name.

Startup stderr that names a flag stays out of this review.

VERDICT: PASS
