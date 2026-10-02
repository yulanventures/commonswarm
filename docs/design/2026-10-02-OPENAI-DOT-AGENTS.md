# OpenAI Dot agents in CommonSwarm

Date: 2026-10-02. Lane P5. Proposed design only.

Use hosted MCP OAuth and a reused named seat for member access. Start with turn
checks. Offer idle wake only after a supported OpenAI host adapter is documented
and measured against the actual cloud root.

Code citations below refer to this lane checkout at
`8434492c363628028c946972659672b9b0fc8872`, equal to `origin/main`.
This source ref does not prove deployment.
Resolve code line numbers against this checkout.
No tests ran and no service was contacted. Current vendor support and production
behavior are **not verified**. No official OpenAI documentation establishing a
Dot wake interface was supplied or fetched.

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
It does not mean this lane reran the measurement. No Dot wake path here has
verified vendor documentation. That does not establish that OpenAI lacks one.

| Candidate path | Evidence class | What it establishes | Gap and decision |
|---|---|---|---|
| Hosted MCP notifications | **NOT VERIFIED** for Dot. CommonSwarm source inspected. | The hosted endpoint accepts POST only and advertises tools. It accepts client initialization notifications. That is not a server wake channel. Sources: `supabase/functions/mcp/protocol.ts:209`, `supabase/functions/mcp/protocol.ts:254`, `supabase/functions/mcp/protocol.ts:267`. | Need vendor documentation that server events resume the same idle cloud root. Adding SSE or notifications alone cannot prove this. Keep turn checks. |
| OpenAI webhook or event ingress | **NOT VERIFIED**. No vendor-documented public Dot ingress is established. | C3PO explicitly reports the missing adapter. Source: `/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:16`. | Discover and document a supported host event adapter. Do not invent a wake URL or equate an API completion webhook with a Dot input channel. |
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

Discovery is a future, separately authorized task. Identify the exact OpenAI
product and runtime behind "Dot". Read its official connector, OAuth, task,
notification, and event-adapter documentation. Ask the platform integration
owner whether an external event can resume the existing idle root, which root
identifier it uses, and where credentials persist. Obtain a supported contract,
not an undocumented endpoint. Record version, consent, limits, cost, restart,
and cancellation semantics. If no supported adapter exists, ship turn-only
support and keep wake unavailable.

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
| Discovery and contract | Small. Can be prepared now without code changes. | Document supported OpenAI runtime, OAuth storage/refresh, capability proof, and event or schedule contract. | Vendor source plus a scoped future measurement plan. Missing capabilities stay **not verified**. |
| Turn-only Dot provider | Medium. After lanes C and D. | Extend `src/cloud/agent-onboarding-contract.ts` and `src/cloud/agent-receive.ts` with a distinct Dot surface. Add proposed `src/cloud/agent-dot.ts` and `src/cloud/agent-dot-contract.ts` for cloud capability validation, connector handles, turn checks, and status. Use hosted MCP instead of local hook files or profiles. Current extension points: `src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-receive.ts:225`. | Actual cloud authorization, identity, repeated-task seat reuse, setup read and reply, denied foreign workspace, refresh, expiry, and revoke proof. Local Codex remains unchanged. |
| Stable binding and recovery | Medium. After lanes C and D, alongside connection orchestration. | Add reviewed Dot/root binding commands and projections in `src/protocol/`, `supabase/functions/command/`, and migrations. Expose safe status through `supabase/functions/read/`. Reuse OAuth in `services/mcp-auth/` and tools in `supabase/functions/mcp/`. Existing seat reuse and check core: `src/protocol/hosted-authority.ts:343`, `src/protocol/hosted-check.ts:114`. | Durable root generation, concurrent-task fencing, explicit new-grant recovery, replay/dedup, restart, unknown send outcome, and human Undo. No name-based adoption or widened grants. |
| Native event wake | Medium only if a supported host adapter exists. Otherwise size unknown and blocked on discovery. After turn-only proof. | Add proposed `src/cloud/agent-dot-events.ts` plus a supported cloud host bridge. Extend hosted protocol only if the vendor contract requires it. Do not copy Claude's experimental channel as a generic wake contract. Current channel declaration: `src/cloud/agent-channel.ts:240`. | Idle actual cloud root receives a directed correlated test and returns a server-recorded receipt without a manual user turn. Prove duplicate, disconnect/reconnect, offline, restart, revoked grant, foreign workspace, and credential-expiry behavior. |

The full provider is not small enough for an immediate registry edit. Secure
cloud activation and idle resume are still **not verified**. Prepare the
discovery brief now; put implementation after C's routine administration and D's visible audit
and recovery. Consume their contracts without changing their ownership or
grant scope. The strategy orders connection orchestration after both lanes.
Source: `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:217`.

A child completing a task, a working local Codex hook, an OAuth callback, and a
roster entry each prove less than native Dot wake. The acceptance target is the
idle cloud root and its correlated service receipt. Until that passes, report
turn-only connection and the remaining host gap plainly.
