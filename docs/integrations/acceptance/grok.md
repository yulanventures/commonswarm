# Grok host acceptance plans

Checked 4 October 2026 at source `61f187c527b51e9946f607691dd056e9964d751a`.
This is an acceptance plan. No host setup, sign-in, tool call, or live probe ran.
**NOT VERIFIED:** current deployment parity and acceptance on each named surface.
Delegated completion, per-host support, Registry publication, and wake remain
**NOT VERIFIED**. This plan adds no runtime feature or enrollment API.

**VENDOR-DOCUMENTED** means the linked official page describes the mechanism.
It does not prove CommonSwarm compatibility. **MEASURED, source review** cites
stored repository evidence. It does not mean this host passed a live test.
All proposed run steps and expected CommonSwarm results below are **NOT VERIFIED**
until a later authorized run retains its own `docs/evidence/` artifacts.

## Prerequisites

- HezLead assigns a later run, its recorder, and independent checker.
  Use only an approved synthetic workspace W and its verified UUID/name.
  Record the human owner, exact host surface/version, source SHA, auth/edge/site
  artifact IDs, and schema revision. Missing release evidence blocks the run.
- The person has their own host account and CommonSwarm membership in W.
  Prepare one stable seat name N per host, owner, workspace, and grant.
  Record any reused connection and its prior state. Do not use another seat's profile.
- Approve bounded seat creation, inbox progress, synthetic messages, denial probes,
  and run-owned access withdrawal before the run. Keep private spaces unchecked.
  Home workspace selects a default. It does not exclude other checked workspaces.
  **MEASURED, source review:** shared connection access and consent choices are
  recorded in [reviewer access](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude).
- **MEASURED, source review:** the hosted coordination catalog is recorded in
  [the tool review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).
  The list below was extracted from `HOSTED_TOOL_TABLE` in
  [tools.ts](../../../supabase/functions/mcp/tools.ts) at this source SHA.
  A later run must enumerate and compare its actual catalog and schemas.

`claim_seat`, `whoami`, `check`, `ask`, `note`, `reply`, `working_on`, `members`.

## Hosted discovery and human setup

**NOT VERIFIED for this host:** let its MCP client perform OAuth discovery.
Use these public addresses. Record status and safe metadata only.

| Item | Expected address or value, pending host verification |
| --- | --- |
| MCP resource | `https://mcp.commonswarm.com/mcp` |
| Protected resource metadata | `https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `https://mcp.commonswarm.com/.well-known/oauth-authorization-server` |
| OpenID discovery | `https://mcp.commonswarm.com/.well-known/openid-configuration` |
| Issuer | `https://mcp.commonswarm.com` |
| Resource scope | `mcp` |

**NOT VERIFIED for this host:** check that protected metadata names that exact resource and issuer.
**NOT VERIFIED for this host:** resolve authorization, token, registration, and key endpoints from discovery.
**NOT VERIFIED for this host:** require the resource audience and supported PKCE flow. Do not invent
endpoints or request the separate admin audience. Discovery alone cannot pass
acceptance. **NOT VERIFIED as raw measurement here:** the retained report says
a fresh DCR client returned registration 201, token 200, and eight tools on
2 October. That is not this host's proof. [Report and raw-evidence limits](../../evidence/2026-10-03-reviewer-packet/GAPS-UPDATE.md#authorized-production-evidence).

**NOT VERIFIED for this host:** once per initial connection, the human installs
or enables the host entry, signs in privately, selects only W, makes it Home,
reviews the shared-connection warning, and allows CommonSwarm access.
The owner must establish identity and choose permissions. An agent cannot
approve itself or another person's account. Hosted sign-in may use a different
provider session from `/app`. Confirm that it resolves to W's actual owner.
[Stored consent review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#connect-claude).
Keep all credentials outside chat, config examples, command arguments, and receipts.
One initial setup does not promise lifetime access. Deliberate reconnect is a
separate human consent phase.

## Route A: Grok chat custom connector

**VENDOR-DOCUMENTED:** custom MCP connectors use a public server URL.
Business/Enterprise members need team-admin provisioning first.
[Grok connector guide](https://docs.x.ai/grok/connectors).
**NOT VERIFIED:** CommonSwarm in Grok chat. This result cannot prove Grok Bot
or an xAI API application.

1. **VENDOR-DOCUMENTED:** open `https://grok.com/connectors`.
   Choose New Connector > Custom. Enter `https://mcp.commonswarm.com/mcp`.
   Complete required authentication. [Custom setup](https://docs.x.ai/grok/connectors).
2. **NOT VERIFIED:** finish discovery and the private human consent above.
   Verify actual OAuth client/callback, W, and eight tools. A catalog listing
   is unnecessary for this custom route and is not claimed here.
3. **NOT VERIFIED:** end setup, open a new blank Grok chat, and submit the fresh
   proof below once. Record original tool panels. Missing JSON or further
   approval fails this strict gate. Run lifecycle and cleanup separately.
4. **NOT VERIFIED, exact disconnect control:** after server withdrawal evidence,
   open this connector's management view and disconnect/remove the exact entry.
   Record the actual button and result. If unavailable, leave host cleanup pending.
   Do not press Sign out or Log out.

## Route B: the actual Grok Bot

**VENDOR-DOCUMENTED:** Bots use a persistent cloud computer separate from the
Mac. Connectors are Marketplace plugins. Install with Add, authenticate privately,
and attach with `@`. Connectors, browser sessions, files, and command credentials
are shared across the account. Separate Bot screens do not isolate access.
[Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).
**NOT VERIFIED:** CommonSwarm listing, custom-plugin intake, exact Bot compatibility,
or idle receive. A Grok chat connector does not establish Bot installation.

1. **NOT VERIFIED:** the owner selects one actual cloud Bot and records its host
   identifier from the UI, task ID, account, and execution environment.
   Use a dedicated test account boundary if other Bots must not share W access.
   Seat names cannot solve account-wide sharing.
2. **VENDOR-DOCUMENTED:** open Marketplace, choose the supported plugin, Add,
   complete browser authentication, and attach it to the task with `@`.
   [Plugin steps](https://docs.x.ai/grok-bot/computer-and-apps).
   **NOT VERIFIED:** an available CommonSwarm plugin. If none exists, stop that
   route as BLOCKED. Do not publish one or invent a custom URL screen.
   If available, complete hosted discovery/consent and use the hosted proof below.
3. **NOT VERIFIED, separate existing-tool fallback:** only if the actual Bot can
   launch a local stdio MCP process through an owner-approved adapter, use the
   local route below on its cloud computer. Prove that loader first.
   The vendor computer guide does not establish a custom MCP loader.
   A CLI process on the Mac is not cloud Bot acceptance.
4. **NOT VERIFIED:** the human completes any initial private authentication or
   protected secret request. Record safe permission boundaries only.
   Do not send credentials to the Bot's conversation. Complete setup before
   starting a fresh Bot task. The owner chooses account-wide exposure once.
5. **NOT VERIFIED:** observe calls executing in that actual Bot task.
   Require host-side tool trace and HezLead's matching service metadata.
   A model-supplied Bot ID, local child result, or roster row is insufficient.
   Record account-scoped assurance if there is no stronger binding evidence.
6. **NOT VERIFIED, exact removal controls:** stop only run-owned Bot tasks.
   After server denial evidence, remove the run-owned plugin/connection from
   the actual account controls, or restore the run-added local adapter entry.
   Record remaining account-wide access. Do not reset the shared computer or
   change another Bot's credentials. Unavailable controls leave cleanup pending.

### Separate local stdio route

**NOT VERIFIED:** Grok Bot has a supported custom stdio MCP loader.
The conditional configuration below describes the local CommonSwarm process.
It cannot establish that the Bot can load it. Stop until the actual cloud
loader is demonstrated through an already approved adapter.
**MEASURED, historical:** private file import and inbox reads passed at a named
older artifact. [Import evidence](../../evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md).
A Codex local MCP trace measured identity, checks, note, and reply.
It proves that route only. [Historical trace](../../evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt).
**NOT VERIFIED:** fresh local setup and this host's execution.

1. On the intended host computer, the human obtains their own W agent connection
   through an approved private setup route. If none exists, run `cswarm setup guide`
   and stop until the human completes it. Never copy another seat's credential.
   For a dedicated unbound profile, privately import with:

   ```sh
   cswarm setup --connection-file <private-file> --profile <absolute-profile-path> --host-session-id manual
   ```

   This template contains paths only. Keep the file outside repositories and chat.
   Use owner-only 0700 directories and 0600 files. Do not read the Mac keychain.
2. Merge this public stdio entry into the host's approved configuration.
   Replace executable/profile paths. Preserve existing settings.

   ```json
   {
     "mcpServers": {
       "commonswarm-local": {
         "command": "<absolute-path-to-cswarm>",
         "args": ["mcp", "--profile", "<absolute-profile-path>"]
       }
     }
   }
   ```

   **NOT VERIFIED:** current command/config loading in this host.
   [Local command source](../../../src/cli.ts) and
   [stdio contract](../../../src/mcp/server.ts) are inspection references.
   A managed/bound profile instead needs its actual host session binding.
   Do not pass `manual` to `cswarm mcp` or invent a session ID.
3. Start a fresh session. Submit one request for `whoami` with `{}` then
   `members` with `{}`. Confirm W, principal, and roster before authorizing
   `check` with `{}`. Local MCP does not use hosted handles or `claim_seat`.
   Enumerate its actual catalog from [MCP_TOOL_TABLE](../../../src/mcp/tools.ts).
   The inspected local table has nine tools. Local file/brain operations are
   outside this coordination run. Do not present it as hosted eight-tool proof.
4. Use a separate `enrollment_receipt` observation with `transport: stdio`,
   no hosted grant/seat IDs, actual principal/workspace, profile-scoped assurance,
   and unavailable subject/expiry marked null with notes.
   Keep `receive_proven: false`. Do not invent a `turn_only` field from output.
   The checker matches fresh execution, two read calls, roster, and the owner's
   private setup record. Hosted grant timestamps do not apply to this route.
5. A later authorized local exchange uses its own schemas: `to` recipients,
   no seat argument, and `check.message_id` for cached text.
   Its cursor behavior is not hosted batch/ack behavior. Keep route receipts separate.
6. For withdrawal the authorized human uses their own signed-in CLI:

   ```sh
   cswarm principal revoke --workspace-id <W-UUID> --principal-id <agent-principal-UUID>
   ```

   **NOT VERIFIED:** this host's revoke result. Confirm server withdrawal and
   a refused old-profile call beside an active independent control.
   Stop the owned stdio process. Remove only its run-added host entry and profile
   after evidence retention. Hosted Connected apps does not establish local
   principal withdrawal. Deleting the profile alone does not revoke access.

## Route C: xAI API remote MCP application

**VENDOR-DOCUMENTED:** the Responses API accepts remote MCP via `server_url`,
`server_label`, `allowed_tools`, and `authorization`. HTTP/SSE are supported.
The native SDK calls the filter `allowed_tool_names`. `require_approval` and
`connector_id` are not supported in the compatible Responses API.
[xAI remote MCP documentation](https://docs.x.ai/developers/tools/remote-mcp).
**NOT VERIFIED:** a CommonSwarm API client, protected OAuth storage/refresh,
application approvals, or execution trace. This is developer integration,
separate from consumer connectors and persistent Bot enrollment.

1. The developer needs an already approved application, API budget, credential
   broker, and OAuth client/callback. The human privately approves only W once
   through that application. Confirm grant activation/consent before any model
   request. If that application does not exist, record BLOCKED.
   This assignment does not implement it or authorize a paid request.
2. **NOT VERIFIED:** the application performs hosted discovery, resource-bound
   OAuth, protected token storage, refresh, and withdrawal. It obtains no token
   through model text or another host's credential export.
   Stop if a protected application credential path is missing. C1/auth repair
   and app development need separate assignments.
3. **VENDOR-DOCUMENTED:** the public part of the Responses tool configuration is:
   [Configuration fields](https://docs.x.ai/developers/tools/remote-mcp).

   ```json
   {
     "type": "mcp",
     "server_url": "https://mcp.commonswarm.com/mcp",
     "server_label": "commonswarm",
     "allowed_tools": ["claim_seat", "whoami", "members"]
   }
   ```

   This phase filter was selected from the inspected hosted table.
   The approved broker supplies authentication at the network boundary.
   No credential is present in this public template.
4. **NOT VERIFIED:** use the Route C proof request, recorder receipt, and API
   checker below. Start one fresh Responses request after consent. Capture
   original API tool-call traces and results. The application recorder builds
   the receipt from those artifacts. Model prose cannot supply missing evidence.
5. **NOT VERIFIED:** for the separately approved exchange, generate the tool
   filter from the actual eight-tool hosted catalog. Do not use an empty filter
   or assume an API approval parameter works. Enforce bounded user approval in
   the application. Prove refresh on a later request using the same active grant.
6. **NOT VERIFIED:** withdraw the CommonSwarm grant and require old-request
   identity/check and refresh refusal beside a live independent control.
   Then remove only this remote tool entry, stop owned application work, and
   withdraw/delete only run-owned OAuth material through its protected broker.
   A vendor API key is separate. Do not revoke a shared API key as connector cleanup.

### Route C proof request and recorder receipt

**VENDOR-DOCUMENTED:** Responses returns `id`, `model`, `status`, and `output`.
Its response ID can continue prior context.
[Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses).
**NOT VERIFIED:** the installed client's exact remote-call/result item shape
and completeness. The remote MCP guide does not establish a CommonSwarm trace.
Before an authorized proof, qualify the recorder against actual API output.
If it cannot retain every attempt's arguments, original result, error state,
call ID or unambiguous item reference, and execution order, stop as BLOCKED.
Do not invent a vendor item type or recover a tool result from model prose.

1. **NOT VERIFIED:** the application starts a new run ID and records UTC start
   immediately before submission. Supply no previous response ID, resumed
   conversation, or prior tool/model messages. Retain the safe request body,
   exact expanded input, phase filter, app version, and requested model.
   Keep authorization and all other credential material out of the capture.
2. **NOT VERIFIED:** submit this input once, substituting W, N, and an app-created
   request ID R that meets the discovered claim schema. Use the three-tool
   configuration above. No follow-up input or human approval belongs in this proof.

   > In workspace <W UUID>, call claim_seat with workspace_id <W UUID>,
   > name <N>, and request_id <R>. Then call whoami and members in that order
   > with seat set to the exact returned handle. Call no other tools.
   > Stop on any authentication challenge or required further human action.
   > Do not construct an enrollment receipt. The application records tool evidence.

3. **NOT VERIFIED:** the recorder retains the complete original response and,
   if used, all stream events with their item references. Capture HTTP status,
   request/response IDs, returned model/status, UTC send/receive times, and each
   tool attempt, including failures. A response's `completed` status alone does
   not mean a tool succeeded. Decode original MCP text and JSON-RPC envelopes
   into a separate attempt inventory. Preserve original bytes and source offsets
   so the checker can repeat decoding. Do not capture credential-bearing headers.
4. **NOT VERIFIED:** build the receipt deterministically from that inventory
   and the independently matched fixture/prerequisite record. The application
   recorder, not the model, writes it. A missing observation stays null with a
   reason and blocks PASS. Retain a partial receipt on FAIL or BLOCKED.

All fields below are **NOT VERIFIED** until a later Route C run measures them.
This is a route-specific observation format, not C1's durable receipt or proof.

| Route C receipt field | Required observation |
| --- | --- |
| `type`, `schema_version`, `route`, `run_id`, `outcome` | `enrollment_receipt`, 1, `xai_api_remote_mcp`, unique run ID, and `PASS_CANDIDATE`, `FAIL`, or `BLOCKED`. Only the independent checker decides PASS. |
| `application`, `api_request` | App name/version and recorder version; API endpoint, requested/returned model, request/response IDs, UTC start/send/end, HTTP and response status, and evidence of no prior context. Unknown vendor fields stay null. |
| `grant_id`, `seat_id`, `principal_id`, `seat_name`, `workspace_id` | Decode claim and identity; require agreement. `seat_name` comes from returned `name`. Omit the handle from the receipt. |
| `workspace_name`, `prerequisite_evidence` | Independently matched W name; operator record reference for this returned grant, OAuth client, owner, resource, active consent, and exact creation/activation/consent timestamps. |
| `subject`, `subject_note`, `expires_at`, `expiry_note` | Null with unavailable-output notes when absent from hosted tools. Owner and validity require separate matched evidence. |
| `connection`, `binding_assurance` | Resource URL, `transport: hosted_mcp`, configured state, connected only after matched identity calls, actual returned `turn_only`, `receive_proven: false`, and account-scoped assurance. API IDs do not attest a vendor model or isolated runtime. |
| `granted_capabilities`, `capabilities_evidence`, `exercised_tools` | Actual eight-tool discovery and consent limits; submitted three-tool phase filter; only successfully exercised claim, identity, and roster. Listing is not exercise or permission proof. |
| `tool_attempts`, `host_execution_evidence`, `evidence` | Ordered attempt references with tool name, UTC times, call/item ID, response association, argument/result source offsets, decoded result, and error state. Reference safe request, original response/events, inventory, and prerequisite artifacts. Handles remain only in restricted tool evidence. |
| `application_events`, `further_human_actions`, `ui_observations` | Complete broker/application auth, consent, code, approval, enabling, and redemption event inventory; actual further actions, including none. `ui_observations` is `not_applicable` with the API-only reason. Missing event coverage is unknown, not an empty observed list. |
| `revoke_path`, `cleanup_status` | Exact owner grant-withdrawal route plus protected app-broker cleanup; completed, pending, or not-run with safe evidence references. |

**NOT VERIFIED:** keep Route C artifacts under
`docs/evidence/<UTC-date>-host-acceptance/xai-api/<run-id>/` in the later evidence
checkout. Use mode 0700 directories and 0600 files. Retain `run.json`, safe
`request.json`, original `response.json` and any `events.jsonl`, decoded
`tool-attempts.json`, `receipt.json`, prerequisite records, and `checker.json`.
The restricted originals may include seat handles, never credentials or tokens.

### Route C independent checker

Every check here is **NOT VERIFIED** until HezLead's independent checker performs
it. These API rules replace the chat prompt, six UI flags, and screenshot gate.
No chat UI exists in Route C. Required further human action still fails.

1. Match the returned grant to the actual app OAuth client, owner, W, resource,
   and active unrevoked consent through HezLead's authorized status-only record.
   Keep exact server microseconds. Require creation <= activation and creation
   <= consent, with all three strictly before app run start. Missing, equal-to-start,
   or guessed times fail. Do not query credentials or unrelated customer content.
2. Inspect the actual application capture and safe submitted request. Require
   one fresh initial input, no prior-context reference/messages, the exact phase
   filter and resource, and consistent request/response/model associations.
   API transport or response errors cannot become a successful tool result.
3. Re-decode every original tool item/event. Reconcile all attempts one-for-one
   with the inventory and receipt, including failed attempts. Match arguments,
   original result, call/item references, and execution order. Missing results,
   ambiguous order, omitted failures, or prose-only evidence fail. Reject errors
   and auth challenges at every envelope layer, including `mcp/www_authenticate`.
4. Require exactly three successful tool steps: claim, identity, then roster.
   Match W, N, R, all returned IDs, and the same handle for both read calls.
   Require the principal/name in `members.agents`, `transport: hosted_mcp`, and
   `turn_only: true`. Only adjacent exact retries under Failure stops may precede
   success. Extra tools, unresolved failures, or changed retry arguments fail.
5. Review complete broker/application events through run end. Require no further
   sign-in, OAuth/consent, code entry, enabling, redemption, or execution approval,
   including a required action nobody completed. Missing event coverage fails.
   Do not require screenshots or invent false chat UI flags for this API route.
6. Rebuild the receipt from original evidence and matched prerequisites. Record
   checker identity, UTC decision, artifact references, route and phase, verdict,
   reason, and cleanup status in `checker.json`. This identity verdict leaves
   exchange, refresh, relaunch, denial, withdrawal, and reconnect checks pending.

**NOT VERIFIED:** no Route C run or executable checker was created here.
The Claude-specific `check-c7.mjs` cannot certify API evidence. HezLead arranges
an independent application-evidence review against this scoped contract.

## Routes A and hosted B: fresh-session acceptance and receipt

Every action in this section is **NOT VERIFIED** for this host.
Finish human setup first. Record a new blank chat/task or a fresh CLI session,
its actual ID, and UTC start time. Do not resume or fork an older conversation.
Attach/select the connector in the single initial request where the host supports
that action. Any later enabling or approval fails the strict fresh-session gate.
Submit this template once, with W, N, and the exact host label substituted:

> Use the CommonSwarm connection already approved for this host account.
> In workspace <W UUID>, call claim_seat with that workspace_id, name <N>,
> and a fresh request_id. Then call whoami and members in that order, using
> the exact returned seat handle. Call no other tools. Use existing permission.
> Stop if new sign-in, consent, code entry, invitation redemption, connector
> enabling, or execution approval is required. Return one enrollment_receipt
> JSON block using the receipt fields below. Omit handles and credentials.
> Keep unavailable values null with a note. Do not claim idle receiving.

This receipt records observations. It is not C1's durable enrollment receipt,
recipient proof, or redemption. A roster row cannot attest a particular shared
chat, Bot, or vendor model.

| Receipt field | Required observation |
| --- | --- |
| `type`, `schema_version`, `run_id`, `outcome` | `enrollment_receipt`, 1, unique run ID, `PASS_CANDIDATE`, `FAIL`, or `BLOCKED`. The checker supplies the final verdict. |
| `grant_id`, `seat_id`, `principal_id`, `seat_name`, `workspace_id` | Match actual `claim_seat` and `whoami` results. Never include the handle. |
| `workspace_name` | Use the independently matched W fixture record. Hosted identity does not return this name. |
| `subject`, `subject_note` | Null if absent from hosted output. HezLead checks the authenticated owner independently. |
| `expires_at`, `expiry_note` | Null if absent from output. This does not mean permanent access. |
| `connection` | Exact host/surface, resource URL, `transport: hosted_mcp`, configured state, connected true only after successful identity calls, actual `turn_only`, `receive_proven: false`. |
| `binding_assurance`, `host_execution_evidence` | Account-scoped unless independent host evidence proves more. Include actual chat/task/session references. |
| `granted_capabilities`, `capabilities_evidence`, `exercised_tools` | Record the discovered catalog with its consent limits. A listing alone grants no permission. State that this phase exercised only claim, identity, and roster. |
| `evidence`, `revoke_path`, `cleanup_status` | Safe artifact references, owner withdrawal route, and completed, pending, or not-run cleanup. |

**MEASURED, source review:** claim and identity shapes are retained in
[the tool review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).
Claim returns six fields: grant, workspace, seat, principal, handle, and name.
Identity adds transport and turn-only status. Do not require internal `ok`,
`status`, or event IDs. `members` returns human and agent arrays without a
workspace ID. Bind it through the same handle and matching principal/name.

The recorder retains a private folder in the later evidence checkout at
`docs/evidence/<UTC-date>-host-acceptance/<route>/<run-id>/`.
Use mode 0700 for the folder and 0600 for files. Retain `run.json`, the full
original `transcript.txt`, receipt JSON, safe screenshots or CLI trace, and
HezLead's matched prerequisite record. Handles belong only in restricted tool
evidence. Do not capture tokens, codes, cookies, or secret-bearing URLs.
Record every attempt, original envelope, decoded result, arguments, UTC time,
error flags, exact transcript excerpt, and capture path. Preserve failures.
Keep the expanded initial prompt in a separate capture boundary.
Start six UI flags as null: consent, sign-in, OAuth, code entry, approval, and
invitation redemption. Set false only after observing the complete run.
Record blocking UI and required further human actions even if nobody performs them.

HezLead's independent checker must:

1. Match this returned grant, actual OAuth client, human owner, W, and active
   unrevoked consent to an authorized status-only operator record.
   Require creation, activation, and W consent strictly before session start.
   Keep server microseconds. Missing times, equal times, or guessed grants fail.
2. Compare the complete trace and log one-for-one, including failed attempts.
   Decode JSON-RPC and MCP text envelopes. Reject error-shaped successes and
   auth challenges, including `mcp/www_authenticate` inside decoded payloads.
3. Require successful claim, identity, and roster in order. Match all IDs, name,
   workspace, and handle. Require the claimed principal in `members.agents`.
   Reconcile the receipt and actual execution surface with those observations.
4. Require all six UI flags false, no blocking events, and no further human
   action after the initial request. Missing tool JSON or unknown flags fail.
   A visible connector button or approval dialog cannot be removed from evidence.
5. Review screenshots and the actual fresh session, not only recorder files.
   Record checker identity, UTC decision, exact artifacts, and scoped verdict.

Pattern inputs: [lane 7 pilot plan](/Users/yulanbot/work/cswarm-vision/lanes/lane7-pilot/PILOT-PLAN.md),
[C7 run task](/Users/yulanbot/work/cswarm-vision/lanes/c7-proof/RUN-TASK.md),
and [C7 checker rules](/Users/yulanbot/work/cswarm-vision/lanes/c7-proof/CHECKER.md).
**NOT VERIFIED:** there is no checker for these host plans in this assignment.
The existing `check-c7.mjs` fixes Claude, Cold Agent Test, and an exact prompt.
It cannot certify these routes unchanged. HezLead applies the checklist above
and arranges the independent check. Do not report its synthetic tests as host proof.

## Separate coordination and lifecycle checks

All checks below are **NOT VERIFIED** for each exact route. Run them only after
identity is confirmed and the bounded writes are authorized. They are separate
from the no-further-action fresh-session proof. Retain action approvals honestly.
**MEASURED, source review:** the following argument shapes and expected outcomes
are recorded in [all-tool examples](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#try-every-hosted-tool).
Use the actual returned values, never these placeholders as wire values.

1. Claim a second synthetic seat B in W. Verify B with `whoami` and `members`.
   Retain A and B handles privately and B's principal UUID as P.
   Repeat an unchanged claim with the same request_id. Require the same IDs.
2. Call `ask` from A with recipients `[{"kind":"agent","id":"<P>"}]`,
   body `D3 synthetic question <run-id>`, and a fresh request_id.
   Save the actual returned signal UUID Q. Retry unchanged once and require Q
   again. HezLead reconciles the durable signal/seat counts for duplicates.
3. Call `check` for B without ack. Require Q in the returned batch.
   Repeat without ack and require the pending batch again.
   Then pass only that seat's actual returned batch_id as ack.
   This advances delivery progress. It does not mean work is complete.
4. Call `reply` from B with signal_id Q, a synthetic body, and a fresh request_id.
   Require `in_reply_to` Q. Check A's inbox for that reply.
5. Call `note` from A with a synthetic body and a fresh request_id.
   Call `working_on` likewise. Require actual signal IDs and timestamps.
   A work signal does not claim, block, or close a task.
6. After the released access interval and skew supplied by HezLead, require a
   new identity call through host-managed refresh without new sign-in.
   Repeat identity in a fresh session using the same grant/name.
   Keep refresh and seat-reuse verdicts separate. Do not inspect tokens.
7. Pair a successful W claim with an explicit claim in an owned, unconsented
   synthetic workspace. Require a reached authorization refusal, not a schema
   error or broken transport. Never probe another person's private workspace.
8. In approved disposable fixtures, pair working identity/check controls with
   removed-membership and revoked-seat denials. Then test whole-grant withdrawal
   below. Retain an independent active connection control in the same probe run.
   Cancelled consent and callback/audience refusal also need their own valid
   setup controls. Malformed arguments do not prove audience rejection.

Record one receipt per phase: identity, exchange, refresh, relaunch, denials,
withdrawal, and reconnect. Reconnect requires deliberate new consent, a fresh
claim, and the new returned handle. Preserve the old refusal and new success.
A setup PASS alone leaves full host acceptance incomplete.

## Failure stops

All host outcomes remain **NOT VERIFIED** until checked. Stop for missing tools,
wrong owner/workspace, callback or issuer refusal, secret-visible authentication,
unexpected scopes, missing original output, a stalled run, or an unknown error.
Do not change OAuth policy, broaden consent, buy capacity, or repair C1 in this lane.
During fresh proof, stop immediately on any further enrollment or tool approval.
Report the action required. A supervised tool run may be recorded separately.
It cannot be relabeled as a no-further-action PASS.

**MEASURED, source review:** hosted error shaping is reviewed in
[the retained error review](../../evidence/2026-10-03-reviewer-packet/C3-ACTIONS.md).
[protocol.ts](../../../supabase/functions/mcp/protocol.ts) emits `request_timeout`;
[tool-errors.ts](../../../supabase/functions/mcp/tool-errors.ts) maps `rate_limited`
and generic `tool_failed`. These codes do not prove that a failure is transient.
**NOT VERIFIED for this host:** the proposed retry rule follows
[C7's bounded proof contract](/Users/yulanbot/work/cswarm-vision/lanes/c7-proof/CHECKER.md#evidence-and-decision-rules).
Only an observed `tool_failed`, `rate_limited`, or `request_timeout` may receive an
adjacent autonomous retry during fresh proof. Keep arguments and request_id
unchanged. Preserve every attempt and honor any returned retry time.
Allow at most two retries and ten minutes as a pilot bound.
This is not a vendor promise. Do not provide a follow-up retry prompt.
A non-transient error, missing successful retry, or auth challenge fails that phase.
Stop on successful forbidden access or duplicate writes. Keep safe partial evidence.

## Cleanup and withdrawal

Every cleanup result is **NOT VERIFIED** until recorded for this route.

1. The human opens CommonSwarm `/app`, account menu, **Connected apps**.
   Select the exact run-owned grant and **Revoke connection** for all its seats,
   or **Revoke seat** only for the intended narrower withdrawal.
   Wait for confirmed status. **MEASURED, source review:** these controls and
   denial procedure are recorded in [revoke review](../../evidence/2026-10-03-reviewer-packet/REVIEWER-ACCESS.md#review-cases-and-evidence).
   Their current availability on this host is not verified.
2. Before host removal, attempt identity/check through the old connection.
   Require denial after confirmed withdrawal and refusal to refresh it.
   Pair this with an independent active connection in W in the same probe run.
   Do not silently log in again. Stop if withdrawn access still works.
3. Disconnect the host entry using the route's controls below. Stop only owned
   tasks/processes and close only owned tabs. Restore only run-added public
   configuration. Do not sign out of the person's account.
4. A pre-existing grant needs the owner's explicit selection before withdrawal.
   Never revoke unrelated seats or delete append-only signals to hide a failure.
   Host removal, hidden tools, or process shutdown alone is not server revocation.
   Keep safe history. Already read information cannot be recalled.
5. If a control or resource cannot be reached, record cleanup pending, its exact
   reference, last confirmed state, reason, and owner. Report to HezLead.
   Do not send support messages or run release commands from this plan.

### Route verdicts

Every result remains **NOT VERIFIED** here. Keep separate receipts and checker
verdicts for Grok chat, actual cloud Grok Bot, Bot-local stdio, and xAI API.
For xAI API identity, use the Route C recorder receipt and independent checker
contract above. For later API phases, retain the same request/response, attempt,
application-event, and checker evidence with the phase's own assertions.
The chat prompt, UI flags, and screenshot requirements do not apply to Route C.
A discovery or identity PASS on one route cannot complete the others.
For every route, apply server withdrawal before the host removal steps above.
No local receiver, `cswarm listen`, or wake test is part of these plans.
