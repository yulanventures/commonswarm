I'll review this lane without changing anything: the fold from `8321eae3` to `d7c17124`, the full lane against `origin/main`, and whether each round-2 failure is actually fixed and tested.The fold and the brief are in view. Next I’ll enumerate every command-edge code a `post_signal` can return and check each mapped sentence against the code that produces it.The command path is narrower than the whole edge. I’ll read the fold diff and the tests that claim to pin each round-2 fix.The reply refusal sentence looks false against the edge rule. I’ll measure the partial-page cap next, then run the tests that are supposed to fail if those fixes are reverted.The `forbidden` sentence is still false, so this lane fails. The other round-2 fixes hold, and the read-path access refusals still tell a person to restore access.

## Edge codes a validated MCP `post_signal` can receive

MCP posts `ask`, `note`, `working-on`, or a private `note` reply, with optional `channel` and `until_ms`, and never sends `thread_root_id`, `to[]`, or `attachments`. Thread and attachment codes are therefore not on this path. A 5xx (`internal_error`, `temporarily_unavailable`) is retried by `ThinCommandClient` and then becomes `{outcome: "unknown"}` in `src/mcp/server.ts`, which matches decision 6.

| Code | Status | When | Sentence and next step |
|---|---|---|---|
| `unauthenticated` | 401 | Token missing, malformed, or not live | True. A person must restore access. |
| `session_proof_missing` | 401 | Managed principal, no proof headers | Missing. Generic “check the arguments”. |
| `session_proof_invalid` | 401 | Bad proof, missing session row, or key mismatch | Missing. Same generic step. |
| `session_expired` | 401 | Managed session not live | Missing. Same generic step. |
| `session_conflict` | 409 | Session id or generation mismatch | Missing. Same generic step. |
| `forbidden` | 403 | Reply not eligible, recipient not live, scope, revocation, or route | Sentence false. Next step is an acceptable hedge. |
| `invalid_request` | 400 | Shape or sanitizer refusal | True. Fix the argument. |
| `upgrade_required` | 426 | Client older than `min_client_version` | True. A person must act. |
| `command_id_conflict` | 409 | Same id, different hash or route | True. Stop and keep the id. |
| `rate_limited` | 429 | Signal hourly limit | True. Retry. |
| `channel_not_found` | 404 | Slug absent in the workspace | True. Fix `channel`. |
| `channel_archived` | 409 | Slug archived | True. Fix `channel`. |
| `payload_too_large` | 413 | Raw body over 128 KiB | Not reachable after MCP validation (body ≤ 8,000, about ≤ 500). The owned sentence would be true if it were. |

`session_retired`, `session_not_managed`, `session_already_managed`, `session_leases_live`, and `delivery_not_surfaced` are not returned by `enforceAgentSessionProof` for `post_signal`.

## Findings

**1. PRODUCTION — `forbidden` tells the model the opposite of the reply rule.** `src/mcp/errors.ts:56`

```56:56:src/mcp/errors.ts
forbidden: entry("A reply may target your own ask or an expired signal; a recipient may no longer be active; this agent's access may also have changed.", CHECK_ACCESS),
```

The command edge returns that same bare `forbidden` when the referenced row is missing, not an ask or note, or already expired, and when the caller is not an addressee:

```8476:8481:supabase/functions/command/index.ts
    WHERE workspace_id = ${route.workspaceId}::uuid
      AND id = ${inReplyTo}::uuid
      AND kind IN ('ask', 'note')
      AND until > statement_timestamp()
```

```8484:8504:supabase/functions/command/index.ts
  const addressedByScalar = auth.agent !== null
    ? reference.to_agent_principal_id === auth.agent.principal_id
    : callerUserId !== null &&
      (
        reference.to_user_id === callerUserId ||
        await signalAgentOwnedByUser(
          tx,
          route,
          reference.to_agent_principal_id,
          callerUserId,
        )
      );
  const addressedToCaller = addressedByScalar ||
    await signalNamesRecipient(tx, route, inReplyTo, {
      agentPrincipalId: auth.agent !== null ? auth.agent.principal_id : null,
      userId: auth.agent !== null ? null : callerUserId,
    });
  if (!addressedToCaller) return null;
```

That null becomes `403` `{error: "forbidden"}` at `supabase/functions/command/index.ts:9676`. The CLI states the rule the other way: “you cannot reply to your own ask; reply to the other party's signal” (`src/cli.ts:3924-3926`). An expired signal is refused by `until > statement_timestamp()`, so it is not a permitted target either. The same sentence is also what `ask`, `note`, and `working_on` receive for a dead recipient, a missing `post_signal` scope, revocation, or a failed route. “A recipient may no longer be active” and “access may also have changed” match those causes. The reply clause does not.

`tests/p1-cli/mcp-stdio.test.ts:441` locks this exact string, so restoring the old “a person must restore access” step fails the test, and correcting the sentence would fail it too. The round-2 `forbidden` point is not fixed. `rate_limited`, `channel_not_found`, and `channel_archived` in that same table are true, and their next steps match the edge.

**2. RIGOUR — managed-session refusals on `post_signal` are missing and mis-stepped.** `src/mcp/errors.ts:139-142`

`post_signal` is not in `AGENT_SESSION_PROOF_EXEMPT_KINDS`. For a managed principal, `enforceAgentSessionProof` returns `session_proof_missing`, `session_proof_invalid`, `session_expired` (all 401), or `session_conflict` (409) (`supabase/functions/_shared/agent-auth.ts:254-276`, statuses in `src/cloud/session-wire.ts:147-161`). None of those keys exist in `MCP_ERROR_SENTENCES`. The fallback is:

```139:142:src/mcp/errors.ts
  const sentence = Object.hasOwn(MCP_ERROR_SENTENCES, safeCode)
    ? MCP_ERROR_SENTENCES[safeCode]!
    : entry(`The service returned ${safeCode}${error instanceof CommandHttpError ? ` with status ${error.status}` : ""}.`,
      error instanceof CommandHttpError && error.status >= 500 ? RETRY : error instanceof CommandHttpError && error.status >= 400 && error.status < 500 ? CHECK_ARGUMENTS : PERSON);
```

The report of the code and status is accurate. The next step, “check the arguments; if the problem stays, ask a person”, is the wrong remedy: the proof is a process header, not a tool argument.

**3. RIGOUR — channel enforcement is stricter than the advertised pattern.** `src/mcp/tools.ts:23` and `src/mcp/tools.ts:52`

The schema advertises `CHANNEL_SLUG_RE` with `maxLength` 32. Validation also rejects `channelSlugProblem(item)`. That classifier accepts a pattern match and then rejects reserved slugs (`src/cloud/channels.ts:80`, `src/cloud/channels.ts:125-129`). `all-signals` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` and is refused locally. Uppercase and padded slugs are rejected, which is what fold 2 required; the raw value is not rewritten. The reserved name is the remaining inequality.

**4. RIGOUR — the partial-page test still passes if the byte cap stops dropping rows.** `tests/p1-cli/mcp-stdio.test.ts:590`

The six bodies are about 1,010 characters. The check library previews 1,000 and stops once the 4,000-character budget is exhausted (`src/cloud/agent-check.ts:191-192`), so it already returns 4 of the 6 ids. A direct `capFreshCheck` of that page with a 30,000-character workspace name shows 1 message (`…0001`, 31,535 bytes). While that drop exists, committing the library cursor instead of `lastVisibleId` skips ids 2–4 and the later `deepEqual` to all six ids fails, so the test does prove no skip or repeat for the split it actually produces, and the final call expects an empty page.

`length < 6` is already true of the library’s 4. If `capFreshCheck` returned every library message, the first page would still be a strict prefix, the cursor would sit on id 4, and ids 5 and 6 would arrive. The test would pass with the byte cap removed. Raising `AGENT_CHECK_BODY_BUDGET` fails the separate “largest page still shows the final id” assertion, not this one.

**5. RIGOUR — two `LANE.md` claims are stale or untested.**

Fold 1 R9 still says channel normalization and the recipient bound are shared with the CLI, and that the stdio test checks “normalized channel posting” (`docs/evidence/2026-09-23-mcp-lane2/LANE.md:63`). Fold 2 stopped normalization and removed the CLI 80-character cap. The schema test rejects `TEAM-UPDATES` and posts `team-updates` unchanged (`tests/p1-cli/mcp-stdio.test.ts:663-669`).

The policy-row correction in R10 (`LANE.md:64`) matches the fixture: `policy.host-session.mcp.keep` and every `selected-error.mcp.*` row exit 1 with `too many positional arguments: expected 1, received 2`. `tests/p1-cli/mcp-stdio.test.ts:691-703` checks only `mcp.missing-profile`, `mcp.unreadable-profile`, and `mcp.manual-host-session`. Restoring the old “these rows reach MCP policy” sentence fails no test.

## Round-2 points that hold

- Unknown argument names are JSON-quoted and cut at 64 characters (`src/mcp/tools.ts:47`). `an unknown argument name is echoed quoted and bounded` passed under a temporary `HOME`. Dropping the slice or `JSON.stringify` fails that exact string, including the newline case.
- The CLI resolver is exact-match again, with no length gate (`src/cloud/signals.ts:1476-1518`), the same acceptance rule as `origin/main`. A 256-character name resolves; `CLI recipient resolution accepts a full database text name` passed. Putting the 80-character check back fails it.
- Read `401`, `403`, and `426` are forced to `read_refused` before any body code (`src/mcp/errors.ts:122`), sentence “The service refused this read.”, next step “a person must restore this agent's access outside this session” (`src/mcp/errors.ts:102`). The stdio test checks all three payloads (`tests/p1-cli/mcp-stdio.test.ts:464-469`).
- Startup stderr that names a flag stays out of this review, as the lead ruled.
- The nine brief decisions still hold in structure: seven library tools, process-only profile and host session, allow-listed arguments and results, `request_id` as `command_id`, unknown after a lost answer, deferred cursor commit, one-shot renewal, and a `tool: null` stdio row. Decision 8’s owned `forbidden` sentence is the break. Model-visible tool text, owned sentences, and validation errors do not carry a shell command, flag, path, token, or producer message. The unknown-argument echo quotes the caller’s own key, bounded. Producer text such as `cswarm session status` is dropped by `mapMcpError`.

VERDICT: FAIL
