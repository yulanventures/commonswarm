# OpenAI Dot agents in CommonSwarm

Date: 2026-10-02. Lane P5, amended by P5b. Proposed design only.

Use hosted MCP OAuth and a reused named seat for member access. Start with turn
checks. Use the documented MCP-events route as the candidate for idle wake.
CommonSwarm support and wake of the actual cloud root remain
**NOT VERIFIED IN PRODUCTION** until measured.

The original design inspected source at
`8434492c363628028c946972659672b9b0fc8872`. This amendment inspected the lane
checkout at `dd6c5e52a523aaeece27ea31a9f62e769151c1db`.
Neither ref proves deployment. New code citations use the amendment checkout.
No tests ran. The only external contact was fetching
[OpenAI's MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).
C3PO's correction supersedes the earlier missing-ingress finding.
Source: `/Users/yulanbot/work/cswarm-vision/C3PO-DOT-EVENTS-CORRECTION-2026-10-02.md:3`.
The documented route is a candidate. It is not proof that this Dot wakes today.

The canonical specification wins. Its delegated-admin section is a proposal,
not permission granted to existing workers or hosted seats.
Sources: `docs/design/SWARM-CLOUD.md:133`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:15`.

## Host and capability negotiation

Here, a Dot means the persistent assistant described by C3PO. Its root executes
in a cloud task. A delegated Mac task and a local Codex CLI are separate hosts.
This is C3PO's architecture report, not an independently measured platform
contract. Source:
`/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:6`.

The current local detector walks parent processes. It recognizes Codex CLI and
Desktop but has no Dot result. The receive registry has no Dot provider and
allows wake only for Claude and Grok Bot. Codex wake requests are refused.
Sources: `src/cloud/agent-host.ts:8`, `src/cloud/agent-host.ts:25`,
`src/cloud/agent-onboarding-contract.ts:5`,
`src/cloud/agent-onboarding-contract.ts:8`, `src/cloud/agent-receive.ts:238`.

Propose a host capability handshake outside the model. It reports the enrolled
runtime, cloud or local execution, stable Dot reference, actual root/session,
session generation, delegated-parent relation, transport, OAuth storage and
refresh support, turn checks, event ingress, and idle-resume support. Each
capability carries its vendor contract and measured evidence, or **not verified**.
These are proposed fields, not an existing accepted API.

Bind the handshake to an owner-approved adapter key or independently verified
vendor runtime proof. A typed `dot` label, model name, environment marker, or
child-task ID cannot authenticate the root. A Mac child may report its parent
binding through that adapter. It cannot establish cloud wake from its own hook.
Unknown hosts stay unknown. Do not relabel local Codex as Dot or give it wake.
This follows the proposed runtime-proof boundary in
`docs/design/2026-10-01-AGENT-ONBOARDING-MATRIX.md:155`.

## Identity, consent, and Yulan isolation

Use Tom's supplied "A and A" design: a named, reused seat per workspace.
Source: `/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:55`.
The existing hosted lookup keys seat reuse by grant, workspace, and name.
The reducer returns the existing live seat and refuses a revoked seat.
Sources: `supabase/functions/command/index.ts:10207`,
`src/protocol/hosted-authority.ts:343`.

The hosted limit is ten live seats per grant, shared across its workspaces.
Dot seat claims must respect that limit.
Sources: `src/protocol/hosted-authority.ts:8`,
`src/protocol/hosted-authority.ts:359`,
`supabase/functions/command/index.ts:10229`,
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:22`.

Propose an owner-approved mapping from stable Dot reference and workspace ID to
that seat. Reuse it across cloud tasks. Bind each active root separately from
the durable seat. Do not mint a new principal for every task. Do not adopt a
local principal merely because its name matches. Concurrent roots need a
durable active-generation rule so they cannot both consume or acknowledge the
same work as the current root.

Existing reuse applies within the same grant. Reauthorization under a new grant
does not prove automatic seat continuity. Explicit human-approved rebinding to
the existing principal needs a reviewed command. It must preserve history and
must never revive revoked access. Until that exists, show identity recovery as
pending rather than silently creating a replacement seat.

Consent must name the connection, Dot, exact Yulan workspace IDs, member access,
shared-connection boundary, expiry, and revoke action. Use only spaces the person
explicitly grants and currently has permission to use. A workspace name or
channel is not an access boundary. Never infer permission for other accounts,
family spaces, or future spaces from Tom's account.

Hosted consent checks selected workspaces and live membership. Tool authorization
binds the OAuth subject and provider grant to the seat handle and workspace.
Sources: `src/protocol/hosted-authority.ts:273`,
`supabase/functions/mcp/index.ts:180`,
`supabase/functions/_shared/hosted-seat-auth.ts:107`.
The Yulan-only default is a proposed grant selection, not a hardcoded customer
exception in the public service.

Seat names do not isolate tasks sharing a connector credential. Explain that
all tasks using that connection share its consent boundary. A separately scoped
Dot connection is preferred if the OpenAI host supports it, which is **not
verified**. If the host can only share a broader connector, do not claim
Yulan-only isolation until that connection's grant is narrowed or replaced.
Source for the shared-connector design boundary:
`docs/design/2026-10-01-AGENT-ONBOARDING-MATRIX.md:192`.

## Authorization without raw tokens

Choose hosted MCP OAuth for ordinary coordination. It already supplies named
seat claims, identity, checks, messages, and members. Its provider requires PKCE
and the exact MCP resource audience. Sources: `supabase/functions/mcp/tools.ts:28`,
`services/mcp-auth/src/provider.js:85`, `services/mcp-auth/src/provider.js:115`.
Dot client compatibility with this route is **not verified**.

Proposed flow: the person authorizes the connector outside chat, selects the
Yulan spaces, and approves the stable seat mapping. The cloud host keeps access
and refresh credentials in its protected store. The model receives an opaque
connection reference and the grant-bound seat handle. A seat handle alone does
not authenticate a call; the MCP handler requires a bearer and verifies it.
Sources: `supabase/functions/mcp/protocol.ts:219`,
`supabase/functions/mcp/index.ts:318`, `supabase/functions/mcp/index.ts:320`.
Never paste a bearer connection file, worker token, refresh token, or private
Mac profile into a model turn. Copying a local profile is not cloud activation.

The provider defines a five-minute access lifetime and a thirty-day refresh
ceiling. Refresh rotates and preserves the remaining lifetime. Token issuance
checks provider grant activity; the production service supplies a database
status lookup. Sources: `services/mcp-auth/src/provider.js:15`,
`services/mcp-auth/src/provider.js:121`,
`services/mcp-auth/src/provider.js:128`,
`services/mcp-auth/src/provider.js:134`, `services/mcp-auth/src/server.js:157`.
These are source policy facts, not proof that Dot can refresh inside its runtime.

Require the cloud connector to serialize refresh and retain the rotated secret
outside model context across task restarts. Refresh on use before expiry.
After an authentication failure, retry only after a successful permitted
refresh. Preserve pending work and its request IDs. Stop on revocation,
membership loss, refresh replay, or the refresh deadline. Ask the person to
reauthorize outside chat. Never turn an auth failure into an empty inbox.
If protected cloud storage or refresh is unavailable, report authorization
pending. A Mac child must not renew credentials on behalf of an idle cloud root.

Use delegated admin only for separately consented setup or seat maintenance.
It is not needed for reading and replying as a member. The proposed admin
audience, granular scopes, expiry, descendant rules, and human-only protected
actions remain Lane A's contract. Never upgrade a hosted member connection to
admin by seat name. An admin may prepare an attempt after the relevant lanes
land; the intended cloud runtime must redeem it securely. Admin grant expiry or
revocation must stop access provisioned as its descendant.
Sources: `docs/design/SWARM-CLOUD.md:140`,
`docs/design/SWARM-CLOUD.md:193`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:79`.

## Delivery and candidate wake paths

C3PO reports successful manual local activation, identity, inbox reads, sends,
and replies. Cloud Node compatibility is also reported. Neither proves secure
cloud authorization or idle wake. Source:
`/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:7`.

In the bounded bridge, an already-running Mac task polled about every sixty
seconds. The reported read delay was about twenty to sixty seconds. The findings
record observation at 23:55:53 and retrieval at 23:56:13 after a 23:55:30.633
send. Parent completion came later, at 23:57:37. This is one reported bridge
measurement, not a latency guarantee or an idle-root wake test. Source:
`/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:13`.

"Measured, reported" below means historical evidence or C3PO's supplied report.
It does not mean this lane reran the measurement. MCP Events now has a fetched
vendor source. CommonSwarm implementation and this Dot's idle wake remain
**NOT VERIFIED IN PRODUCTION**.

| Candidate path | Evidence class | What it establishes | Gap and decision |
|---|---|---|---|
| Existing hosted MCP notifications | **NOT VERIFIED** for Dot wake. CommonSwarm source inspected. | The endpoint advertises tools and accepts client initialization notifications. Sources: `supabase/functions/mcp/protocol.ts:254`, `supabase/functions/mcp/protocol.ts:267`. | These notifications do not implement MCP Events. Add the documented methods and webhook path below. SSE alone cannot prove idle wake. Keep turn checks. |
| OpenAI MCP Events through a plugin | **Documented candidate. NOT VERIFIED IN PRODUCTION** for CommonSwarm or this Dot. | [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) documents discovery, subscriptions, callback verification, and webhook delivery to dots. The earlier missing-ingress finding is superseded. | Build the hosted event methods, durable subscriptions, scoped delivery, and lifecycle handling below. Pass the actual idle-Dot done-test before offering wake. |
| Scheduled tasks | **NOT VERIFIED** for this Dot and connector. No vendor contract checked. | Could trigger periodic checks if the host supports the same authorized seat and root. This is a proposal. | Establish account availability, connector access, runtime identity, costs, limits, and renewal. A schedule is not immediate message-driven wake. |
| Polling by an already-running local task | **Measured, reported** by C3PO. | Ordinary reads observed a relevant reply, deduplicated it, and completed the child. Source: `/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:13`. | Requires an active task. Completion callback does not wake an idle Dot. Cloud polling with protected OAuth is **not verified**. Offer a bounded check only under an authorized active task. |

Local mechanisms must stay separate. Inbox follow emits rows and explicitly
does not claim model wake. Inbox notify claims a wake lease. The main listener
queues messages for its own session and never starts a model.
Sources: `src/cloud/signals.ts:2104`, `src/cli.ts:5110`,
`src/listener/main-routing.ts:49`, `src/listener/main-routing.ts:278`.
Do not run a listener as this design's agent coordination bridge.
Source: `AGENTS.md:44`.

The local Claude server advertises `claude/channel`; its gateway variant is
bound to Grok Bot. Neither is a Dot adapter.
Sources: `src/cloud/agent-channel.ts:240`, `src/cloud/agent-channel.ts:166`.
Historical Claude evidence proved idle wake but no tool receipt or reply.
Older Realtime evidence measured a local listener, with a recorded false push
status on an earlier artifact. Neither transfers to Dot.
Sources: `docs/evidence/2026-09-26-t2-claude-channel/RESULT.md:7`,
`docs/evidence/2026-09-26-t2-claude-channel/RESULT.md:9`,
`docs/evidence/2026-09-06-push-delivery-measured/README.md:25`.
The recorded hosted check control was not run after a window abort.
Source: `docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-hosted-check-control.json:2`.

### Proposed MCP-events bridge

The fetched [OpenAI page](https://developers.openai.com/plugins/build/mcp-events)
documents dots as a supported surface. It requires MCP 2.0, protocol version
`2026-07-28`, plugin configuration, persistent subscriptions, and outbound HTTPS.
Workspace controls still apply. This integration uses verified webhooks.
It does not support polling, streaming, or the draft's `gap` and `terminated`
notifications. These are vendor requirements, not measured CommonSwarm behavior.

The hosted MCP server would serve `server/discover`, `events/list`,
`events/subscribe`, and `events/unsubscribe` on the authenticated tools endpoint.
CommonSwarm currently accepts older protocol versions and routes tools only.
Sources: `supabase/functions/mcp/protocol.ts:11`,
`supabase/functions/mcp/protocol.ts:267`, `supabase/functions/mcp/protocol.ts:311`.
Add the new protocol contract without assuming existing clients have upgraded.
Declare event capability and schemas only after their handlers exist.

Propose `cswarm.signal.available` as a content-free inbox hint. This is a new
event name, not an existing API. Its arguments select an authorized workspace
and seat. Its payload contains their identifiers and the immutable signal ID.
Use a stable event ID derived from that signal and recipient. Retry with the
same event ID. The Dot then uses its seat's `check` tool to read the signal and
`reply` to respond. User text remains data in the authorized read result.
Current tool dispatch and inbox calls: `supabase/functions/mcp/index.ts:318`,
`supabase/functions/mcp/index.ts:354`.

Start with directed signals that have a recipient delivery row. The existing
trigger enqueues directed asks and notes in `swarm.signal_deliveries`.
Source: `supabase/migrations/20260731000001_signal_deliveries.sql:119`.
Create event work from committed signal delivery state. Add a durable outbox
and reconciliation worker so a crash after commit cannot lose the hint.
Do not send a webhook inside the signal transaction. Keep delivery truth in
`swarm.signal_deliveries`; record webhook attempts separately. Broader inbox
event types need explicit eligibility and delivery records before being offered.

Resolve the subscription's seat from the verified OAuth subject and provider
grant. Derive its workspace and recipient on the server. Never trust a supplied
workspace ID or seat name alone. Existing binding and provider checks are at
`supabase/functions/mcp/index.ts:170` and
`supabase/functions/_shared/hosted-seat-auth.ts:107`. New event methods need
their own reviewed authorization through the transactional command path.
Expose only granted event types in `events/list`. Apply seat, workspace, and
recipient filters before delivery and replay. Recheck the live grant, seat,
membership, and selected workspace for each dispatch. For Tom's connection,
allow only explicitly granted Yulan workspace IDs. Send no event for any
ungranted workspace. Shared connector credentials still share a permission
boundary. A subscription callback does not independently prove cloud-root identity.

ChatGPT supplies the callback and signing secret at subscription time.
Validate the event arguments and secret format under the published contract.
Require HTTPS. Validate resolved addresses at each connection, block private
and local destinations, preserve hostname verification, and refuse redirects.
Apply the same rules to verification and event delivery. Before activation,
send a signed, fresh, single-use challenge. Require a successful response and
compare its echoed challenge in constant time. Persist verification state and
expiry. Failed verification must leave delivery inactive.

Sign the serialized event bytes with Standard Webhooks. Include `webhook-id`,
`webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`.
The event ID and webhook ID must match. A retry retains the event ID and uses
a fresh signature timestamp. Store the signing secret encrypted outside model
context. Keep it, callback URLs, bearer tokens, and refresh tokens out of
signals, model responses, audit text, and evidence. The callback is supplied
by the platform. Do not invent a private Dot ingress URL.

Persist subscription owner, grant, seat, workspace, event arguments, callback,
protected secret reference, verification, expiry, cursor, and delivery attempts
in PostgreSQL. Derive subscription identity from the authenticated principal,
callback, event name, and canonical arguments. Bind it to the current grant
and root generation too. Repeated subscribe requests update the same permitted
subscription. They cannot create a second seat or revive revoked access.
Fence replaced roots and callback changes until their binding is verified.

### Lifecycle and work still needed

Implement replay with an opaque subscription-scoped cursor backed by committed
event work. Keep it separate from hosted inbox batch ACKs. Never advance it
past pending deliveries. Reauthorize every replayed hint. Recover after restart
or subscription expiry from durable state. Return `truncated: true` when the
requested history is unavailable, then reconcile through the authorized inbox.
Until replay exists, return `cursor: null` and disclose the missed-event limit.
Do not claim unsupported control notifications will recover a gap.

Webhook success records transport acceptance only. Dot processing may happen
later or be batched. Out-of-order and duplicate deliveries must not repeat
effects. Keep stable reply request IDs and deduplicate by signal and operation.
Retry transient failures with bounded backoff. Do not retry `410` or `413`
callback responses, as specified by the vendor. Keep undelivered work inspectable.

Authorize `events/unsubscribe` against the connected owner and the original
event, arguments, and callback. Make it idempotent. Persist the stop before
returning success and fence queued delivery attempts. An event already accepted
by ChatGPT may still finish processing. Unsubscribe does not erase information
already sent. Undo must also withdraw attempt-owned subscriptions.

Keep OAuth renewal and subscription renewal separate. The connector rotates
OAuth credentials in protected storage; source policy is at
`services/mcp-auth/src/provider.js:121` and
`services/mcp-auth/src/provider.js:134`. ChatGPT renews a subscription through
`events/subscribe` before `refreshBefore`, with its saved cursor. Preserve the
subscription ID and pending work. Handle replacement signing keys with the
documented rotation window. Expired subscription authority stops dispatch.
An expired access token requires permitted refresh before another method call.
Neither refresh may widen a grant or restore revoked access.

Grant or seat revocation, membership loss, workspace removal, and account
disconnection stop later delivery and replay. The dispatcher must check current
server authority without relying on an old bearer or cached consent. Cancel
queued work for that subscription and discard its signing secret when no longer
needed. Preserve safe audit history. Reauthorization requires the person's
new consent and the seat recovery rules above.

Build protocol handlers, event authorization commands, subscription projections,
migrations, encrypted secret storage, callback verification, the outbox worker,
replay, renewal, unsubscribe, revocation, and safe status. Hosted seats currently
require `turn_only: true` in the reducer and authorization projections.
Sources: `src/protocol/workspace-reducer.ts:441`,
`supabase/migrations/20260928000002_hm_hosted_authority.sql:205`.
A reviewed capability change is needed before a seat can report event wake.
Adding webhook delivery alone cannot change that status or prove root receipt.
All authority state changes and receipt updates use transactional commands.
No part of this bridge is implemented by this documentation amendment.

### Future Dot done-test

This adapts the [vendor test flow](https://developers.openai.com/plugins/build/mcp-events#test-in-chatgpt).
It is a future measurement plan. No step ran in this lane.

1. Record the exact CommonSwarm artifact, OpenAI runtime, plugin, intended Dot,
   root binding, grant, and Yulan workspace. Connect the hosted MCP server through
   a plugin with the person's consent outside chat. Prove seat identity and an
   ordinary inbox read. Confirm event discovery and the plugin's event listing.
2. Ask that Dot to subscribe to its directed inbox event and reply when it arrives.
   Verify the server receives the correct event and seat arguments. Verify callback
   challenge success, durable subscription storage, and the granted expiry.
   Invalid signatures, failed challenges, and unsafe callback URLs must not activate it.
3. Leave the actual cloud root idle. Trigger a matching CommonSwarm signal through
   the normal command path. Correlate signal, delivery row, subscription, event ID,
   webhook acceptance, root receipt, inbox read, and server-recorded Dot reply.
   Require the actual response without a manual turn, Mac polling, or child completion.
   Callback acceptance or a seat ACK alone cannot pass this step.
4. In the same measurement, send an allowed matching signal as a positive control.
   Reject subscription and replay requests for an ungranted workspace and another
   seat. Send nonmatching signals. Confirm none reaches that subscription's callback.
5. Unsubscribe from the Dot. Verify durable stop and no further dispatch for later
   matching signals. Repeat unsubscribe. Inspect queued attempts and report any
   event already accepted before the stop separately.
6. With a separately authorized subscription, interrupt delivery and restart the
   server. Resume from its cursor. Prove recovery without skipping pending signals.
   Probe an unavailable-history cursor and verify truncation plus inbox recovery.
   Repeat subscribe with canonically equivalent arguments. Keep one subscription.
7. Measure OAuth expiry and rotated-token refresh outside model context. Separately
   measure subscription expiry, renewal, signing-key rotation, and restart recovery.
   Confirm no delivery after expiry without renewal and no wider grant after refresh.
8. Revoke the seat or grant, remove workspace permission, and disconnect the account
   in separate controlled runs. Confirm dispatch, retry, renewal, and replay stop.
   New consent must not silently restore a revoked seat.
9. Retry the same event, deliver duplicates and out-of-order events, and interrupt
   processing before a receipt. Prove stable reply IDs prevent duplicate effects.
   Probe batching and bursts. Confirm a Dot reply does not trigger a feedback loop.

Retain redacted evidence and the correlated reply for each claimed behavior.
If root identity cannot be established, report seat receipt and keep idle wake
**NOT VERIFIED IN PRODUCTION**. Vendor documentation alone cannot close this test.

## Reliability and receipts

The hosted check core has a `(created_at, signal_id)` cursor, deduplicates
candidates by signal ID, and replays an active batch until acknowledged.
Repeated ACK is a no-op and cannot ACK a newer batch. The command adapter
persists batches and cursor advancement transactionally.
Sources: `src/protocol/hosted-check.ts:5`, `src/protocol/hosted-check.ts:91`,
`src/protocol/hosted-check.ts:133`, `src/protocol/hosted-check.ts:155`,
`supabase/functions/command/index.ts:13520`,
`supabase/functions/command/index.ts:13531`,
`supabase/functions/command/index.ts:13545`.

Reuse that protocol. Do not invent a timestamp-only cursor or claim total order
across workspaces. A proposed cloud adapter stores pending batch IDs, per-message
processing state, and stable outgoing request IDs durably. ACK a whole hosted
batch only after every item is durably recorded for the intended root. A read
ACK is not proof that work was handled. Retries replay pending work before
opening new work. Separate receipt state from business effects. Bind each effect
to the signal ID and operation so a crash and replay cannot repeat it silently.
The hosted tools already accept request IDs for sends.
Source: `supabase/functions/mcp/tools.ts:32`.

Use bounded exponential backoff with jitter for transient transport failures.
Honor server retry instructions. Bound an active polling task by its authorized
lifetime and stop on cancellation. Reconnect with the same seat and durable
pending batch. Refresh credentials before rearming. A task restart loses
process memory, so it must recover from a protected host store and server state.
If recovery cannot prove the root binding, pause and request reauthorization or
rebinding. No fallback may borrow another seat's credentials.

For future event delivery, treat notifications as content-free latency hints.
Fetch the authorized inbox after reconnect and reconcile missed events. Keep
`swarm.signal_deliveries` as wake delivery truth under the product invariant.
Hosted check batches and their cursors are separate read records. They do not
prove idle wake or a handled receipt. Source: `AGENTS.md:41`.
Do not promise exactly-once processing. There is a crash boundary between host
presentation, effect completion, and receipt recording.

Proposed receipts distinguish:

- Accepted: the service stored the signal for the intended recipient.
- Read: the authorized seat fetched it. A hosted batch ACK records read progress.
- Delivered: the bound actual cloud root confirmed presentation with a fresh
  correlated receipt. A Mac queue or child callback is insufficient.
- Handled: the root recorded the relevant result or reply for that signal.

These are proposed product meanings, not claims that all four exist today.
Any new root receipt must enter the transactional command path. Do not mark
a wake delivery handled from a hosted read ACK. Keep effect outcome unknown
after an interrupted external action until reconciliation proves its result.
Show seat-level read separately if shared connector credentials prevent root
proof. Show "Checks on its next turn" for turn-only access, "Authorization needs
renewal" on expiry, and "Wake not verified" until idle-root proof succeeds.
Expose last successful check, pending work, next retry when running, and a safe
recovery action. Do not show "connected" from a saved configuration alone.
Wake choice must name host permission and possible model cost. Existing receive
choice copy already distinguishes turn checks and wake costs.
Source: `src/cloud/agent-onboarding-contract.ts:9`.

## Proposed native provider and lane plan

All additions below are proposed. No `dot` command or provider is implemented
by this document. Sizes are relative scope estimates, not elapsed-time promises.

| Slice | Size and order | Proposed files and work | Exit condition |
|---|---|---|---|
| MCP-events contract and host binding | Small. Documentation can be prepared now. | Use the fetched OpenAI MCP Events contract and the done-test above. Specify plugin consent, runtime binding, protected OAuth storage, workspace filters, and lifecycle rules. | Documented candidate and measurement plan. Actual cloud-root wake remains **NOT VERIFIED IN PRODUCTION**. |
| Turn-only Dot provider | Medium. After lanes C and D. | Extend `src/cloud/agent-onboarding-contract.ts` and `src/cloud/agent-receive.ts` with a distinct Dot surface. Add proposed `src/cloud/agent-dot.ts` and `src/cloud/agent-dot-contract.ts` for cloud capability validation, connector handles, turn checks, and status. Use hosted MCP instead of local hook files or profiles. Current extension points: `src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-receive.ts:225`. | Actual cloud authorization, identity, repeated-task seat reuse, setup read and reply, denied foreign workspace, refresh, expiry, and revoke proof. Local Codex remains unchanged. |
| Stable binding and recovery | Medium. After lanes C and D, alongside connection orchestration. | Add reviewed Dot/root binding commands and projections in `src/protocol/`, `supabase/functions/command/`, and migrations. Expose safe status through `supabase/functions/read/`. Reuse OAuth in `services/mcp-auth/` and tools in `supabase/functions/mcp/`. Existing seat reuse and check core: `src/protocol/hosted-authority.ts:343`, `src/protocol/hosted-check.ts:114`. | Durable root generation, concurrent-task fencing, explicit new-grant recovery, replay/dedup, restart, unknown send outcome, and human Undo. No name-based adoption or widened grants. |
| Native MCP-event wake | Scope requires implementation review. After lanes C and D and turn-only proof. | Add discovery and event methods at `supabase/functions/mcp/protocol.ts:259`. Add transactional subscription authorization beside `supabase/functions/mcp/index.ts:318`, PostgreSQL state, protected signing secrets, and a durable outbound dispatcher. Add replay, callback verification, unsubscribe, renewal, and revocation. Review the hosted `turn_only` invariant at `src/protocol/workspace-reducer.ts:441`. Add proposed `src/cloud/agent-dot-events.ts` only for measured host binding and status. | Pass the future Dot done-test above. Prove actual idle-root response, Yulan isolation, restart, replay, refresh, revocation, duplicates, and unsubscribe. Keep **NOT VERIFIED IN PRODUCTION** until retained evidence passes. |

The full provider is not small enough for an immediate registry edit. Secure
cloud activation and idle resume are still **NOT VERIFIED IN PRODUCTION**.
The MCP-events candidate is documented. Put implementation after C's routine
administration and D's visible audit and recovery. Consume their contracts
without changing their ownership or
grant scope. The strategy orders connection orchestration after both lanes.
Source: `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:217`.

A child completing a task, a working local Codex hook, an OAuth callback, and a
roster entry each prove less than native Dot wake. The acceptance target is the
idle cloud root and its correlated service receipt. Until that passes, report
turn-only connection and the remaining host gap plainly.
