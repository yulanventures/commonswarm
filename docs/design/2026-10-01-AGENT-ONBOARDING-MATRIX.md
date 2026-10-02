# Agent onboarding across vendors

Date: 2026-10-01. Lane P1. Design preparation only.

Source review uses checkout `4d6a06509f9abf1aefac8c88ec00280d025df673`.
No tests were run and no service was contacted. Current deployment, installed
vendor versions, and current vendor compatibility are **not verified**.
Historical evidence proves only the recorded artifact and host.

The target is one admin request that invites and connects another agent. The
person sees the result and can withdraw access. This follows the phased memo's
connection flow and preparation scope.
Sources: `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:144`
and `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:228`.

Tom chose both granular and full-account grants. Granular is the default.
Workspace creation is a separate permission. Full-account access requires an
explicit human confirmation and remains visible, revocable, and audited.
This decision supersedes the memo's earlier either-or recommendation.
Sources: `/Users/yulanbot/work/cswarm-vision/lanes/task-p1.md:3` and
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:8`.

## Current foundation

Ordinary agent credentials cannot create workspaces, invite members, create
principals, or mint other worker tokens. Hosted seat credentials also cannot
execute workspace management commands. Delegated setup needs Lane A's new
grant contract and an explicit canonical-spec amendment. This document adds
no permission to current credentials.
Sources: `docs/design/SWARM-CLOUD.md:125`,
`src/protocol/workspace-commands.ts:410`,
`src/protocol/workspace-commands.ts:664`.

The command contract specifies server-derived identity, transactional permission
checks, events, projections, and idempotent command responses. The command
handler calls `decideWorkspace` and records accepted or domain outcomes.
Sources: `docs/design/SWARM-CLOUD.md:85`,
`docs/design/SWARM-CLOUD.md:93`,
`supabase/functions/command/index.ts:12412`,
`supabase/functions/command/index.ts:12664`.

The local MCP bootstrap asks a signed-in person to mint a code and enter it
privately on the agent host. It prints Claude Code and Codex configuration.
It does not install that configuration for the person.
Sources: `src/cloud/agent-onboarding-contract.ts:46`,
`src/cloud/mcp-connect.ts:324`, `src/cloud/mcp-connect.ts:620`.

The receive registry names `claude`, `codex`, `instructions`, and `grok-bot`.
Only `claude` and `grok-bot` are accepted wake providers. Configuration alone
does not prove a working hook or wake path.
Sources: `src/cloud/agent-onboarding-contract.ts:5`,
`src/cloud/agent-onboarding-contract.ts:8`,
`src/cloud/agent-receive.ts:101`, `src/cloud/agent-receive.ts:238`.

## Vendor capability matrix

"Today" means the checked-in route. It does not mean a fresh production test.
An unavailable dedicated adapter does not establish that a vendor lacks MCP.

| Agent surface | Connect path today | Wake path | Identity | Proven and not measured |
|---|---|---|---|---|
| Claude Code CLI | Operator code, local `cswarm mcp connect`, then the printed stdio install command and a fresh session. Sources: `src/cloud/agent-onboarding-contract.ts:46`, `src/cloud/mcp-connect.ts:620`. | Turn hooks. Optional preview channel resumes the same session and needs host approval. Sources: `src/cloud/agent-receive.ts:263`, `src/cloud/agent-receive.ts:269`. | MCP uses the profile's principal and workspace. Profiles may be session-bound; operator guidance describes the unbound bootstrap. Sources: `src/mcp/server.ts:69`, `src/cloud/agent-profile.ts:49`, `src/cloud/agent-onboarding-contract.ts:46`. | Production setup and inbox checks were recorded, but that run did not observe a hook firing: `docs/evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md:10`, `docs/evidence/2026-09-08-agent-onboarding/LIVE-CONTROLS.md:18`. Later T2 proved an idle terminal wake and a turn hook at its pin, but no delivery ACK or CommonSwarm reply: `docs/evidence/2026-09-26-t2-claude-channel/RESULT.md:7`, `docs/evidence/2026-09-26-t2-claude-channel/RESULT.md:50`. The notice repair landed with its live control still open: `docs/evidence/2026-09-26-item-g-g3a/LANDING.md:23`. Current wake ACK/reply and fresh code bootstrap are **not verified**. |
| Claude apps via hosted MCP | Approved design: add the hosted connector URL, sign in, select workspaces, then claim a seat. Sources: `/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:8`, `/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:42`. Checked-in OAuth requires PKCE and the MCP resource audience. Sources: `services/mcp-auth/src/provider.js:115`, `services/mcp-auth/src/provider.js:85`. Live app connection is **not verified**. | Hosted seats are `turn_only`. Source: `src/protocol/workspace-reducer.ts:441`. The `check` tool opens or acknowledges a durable message batch on a tool call. Sources: `supabase/functions/mcp/tools.ts:31`, `supabase/functions/mcp/index.ts:352`. No hosted wake claim. | Reusable seat under a grant, workspace, and name. The lookup binds that key; the decision returns the existing live seat. Sources: `supabase/functions/command/index.ts:10210`, `src/protocol/hosted-authority.ts:343`. Chats share the connector account's permission boundary. Source: `/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:24`. | The checked-in tool table includes claiming, identity, inbox, messaging, current work, and members: `supabase/functions/mcp/tools.ts:28`. The recorded HM37 hosted check did not run after a window abort: `docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-hosted-check-control.json:2`. That is historical, not a current release verdict. Claude web, Desktop, mobile, and Cowork done-tests are each **not verified** here. |
| Codex CLI | Same operator bootstrap; connect emits a `[mcp_servers.cswarm]` stdio configuration. Source: `src/cloud/mcp-connect.ts:620`. | Codex turn hooks are installed. Codex is outside the accepted wake set. Sources: `src/cloud/agent-receive.ts:263`, `src/cloud/agent-receive.ts:238`. | Profile principal and workspace. A bound profile rejects another host session. Sources: `src/mcp/server.ts:69`, `src/cloud/agent-profile.ts:49`. | A recorded Codex MCP host run completed identity, check, note, reply, and a second check: `docs/evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt:2`. The code-bootstrap done-test remained open in the release record: `docs/evidence/2026-09-24-mcp-release2/LANDING.md:67`. Fresh delegated installation and a real current turn hook are **not verified**. Historical ACP listener results are a separate path: `docs/evidence/2026-08-06-agent-wake-round-trip.md:74`. |
| OpenAI Dot | Proposed hosted MCP OAuth in the actual cloud runtime. No bearer connection files in chat. Named seat tools and PKCE exist in source: `supabase/functions/mcp/tools.ts:28`, `services/mcp-auth/src/provider.js:115`. Dot OAuth compatibility, protected cloud storage, and refresh are **not verified**. | Turn checks first. C3PO reports polling by an already-running Mac task and a later parent completion callback, not idle Dot wake: `/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:13`. Hosted notifications, OpenAI event ingress, and scheduled Dot checks are **not verified**. No Dot wake provider is registered: `src/cloud/agent-onboarding-contract.ts:8`. | Proposed stable Dot seat per explicitly consented Yulan workspace, reused across tasks, with separate actual cloud root binding. Existing reuse is grant/workspace/name scoped: `supabase/functions/command/index.ts:10207` at checkout `8434492c`, `src/protocol/hosted-authority.ts:343`. The grant has a ten-live-seat cap across its workspaces: `src/protocol/hosted-authority.ts:8`, `src/protocol/hosted-authority.ts:359`, `supabase/functions/command/index.ts:10229` at checkout `8434492c`. A Mac child or local Codex is not its host. Shared connector seat names do not isolate tasks; new-grant continuity needs reviewed rebinding. | Local identity, inbox, sends, and replies are reported by C3PO, not rerun here: `/Users/yulanbot/work/cswarm-vision/C3PO-DOT-AGENT-FINDINGS-2026-10-02.md:7`. Secure cloud activation, root proof, idle receipt, restart, refresh, and unauthorized-workspace rejection are **not verified**. See [OpenAI Dot design](2026-10-02-OPENAI-DOT-AGENTS.md) for the wake evidence table and phased work after lanes C and D. |
| Grok Bot | Generic connection-file setup with the dedicated `grok-bot` receive provider. Sources: `src/cloud/agent-onboarding-contract.ts:47`, `src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-setup.ts:32`. | Optional local gateway, exact Bot UUID, receiver on the Bot computer, and idle test. Sources: `src/cloud/agent-receive.ts:241`, `src/cloud/agent-receive.ts:281`, `src/cloud/agent-receive.ts:307`. | CommonSwarm principal in the profile plus a separate Bot UUID bound to the receiver. Sources: `src/cloud/agent-profile.ts:34`, `src/cloud/agent-receive.ts:259`. | Gateway code sends to that UUID through a local endpoint: `src/cloud/agent-grok-bot-gateway.ts:26`. A real Bot setup, idle receipt, and reply are **not verified**. Old Grok CLI evidence is not Bot evidence: `docs/evidence/2026-07-31-host-protocol-matrix-reconciliation.md:40`. |
| Gemini / agy | No dedicated entry in the receive registry. Generic connection-file setup and instruction checks are the checked-in fallback. Sources: `src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-onboarding-contract.ts:47`, `src/cloud/agent-onboarding-contract.ts:50`. Vendor MCP installation is **not verified**. | No dedicated wake provider in the current registry. Source: `src/cloud/agent-onboarding-contract.ts:8`. | Use the authenticated CommonSwarm principal. Source: `src/cloud/agent-profile.ts:34`. Host detection returns unknown at a Gemini CLI boundary. Source: `src/cloud/agent-host.ts:37`. agy session identity is **not verified**. | The older audit found Gemini CLI absent and measured agy help only. It explicitly did not prove Gemini CLI or ACP support: `docs/evidence/2026-07-31-host-protocol-matrix-reconciliation.md:37`. Current versions, MCP, consent, and turn hooks are **not verified**. |
| Cursor | Generic setup and instruction checks are the candidate existing route; no Cursor-specific receive provider is registered. Sources: `src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-onboarding-contract.ts:47`. Cursor MCP installation is **not verified**. | No Cursor-specific wake provider. Source: `src/cloud/agent-onboarding-contract.ts:8`. | Use the authenticated profile principal. Cursor markers can feed the Bot host heuristic; they do not authenticate a Cursor seat or prove its adapter. Sources: `src/cloud/agent-setup.ts:57`, `src/cloud/agent-host.ts:20`. | Cursor UI, CLI, config loading, hook execution, and wake compatibility are **not verified**. The provider registry is evidence of the fallback, not a vendor completion test: `src/cloud/agent-onboarding-contract.ts:5`. |
| Meta Muse | Named in Tom's vision. No connection surface is established in this review. Source: `/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:4`. | **Not verified**. Choose turn checks only after a callable route is measured. | Account, runtime, consent, and stable agent identity are **not verified**. | No Muse runtime or CommonSwarm integration was measured in this assignment. Do not advertise support. |
| Generic MCP client | Local stdio server over a private profile. A remote hosted resource and tool table also exist in source. Sources: `src/mcp/server.ts:69`, `supabase/functions/mcp/index.ts:375`, `supabase/functions/mcp/tools.ts:28`. Host compatibility is **not verified**. | MCP alone does not establish wake. Hosted seats are turn-only; local wake requires an accepted receiver. Sources: `src/protocol/workspace-reducer.ts:441`, `src/cloud/agent-onboarding-contract.ts:8`. | Local: authenticated profile principal. Hosted: grant-bound named seat. Sources: `src/mcp/server.ts:104`, `supabase/functions/command/index.ts:10210`, `src/protocol/hosted-authority.ts:343`. | Codex evidence proves one local client, not every client: `docs/evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt:2`. Remote discovery, authorization, refresh, seat reuse, and message round trips for another client are **not verified**. |

Older listener measurements must not become claims about current same-session
channels. The older wake record used an ACP listener and different artifacts.
Sources: `docs/evidence/2026-08-06-agent-wake-round-trip.md:31`,
`docs/evidence/2026-08-06-agent-wake-round-trip.md:79`.
Repository policy prohibits using a listener for agent coordination and prohibits
the optional listener from starting a model. Sources: `AGENTS.md:43`,
`AGENTS.md:44`.

## Proposed target flow

Everything below is proposed behavior. Command and state names are design names.
They are not an accepted CLI or API contract.

### Grant and request

Lane A owns the grant definition. P1 consumes it without enlarging it.
Granular consent names workspaces, operations, target owners and agents, renewal
limits, and expiry. Workspace creation needs its own permission. Full-account
consent names the account, existing and future workspace coverage, operations,
renewal policy, and revocation action. It still respects that person's current
rights. It does not reach another person's private account.

The person must confirm full-account access directly. An agent cannot create or
expand its own admin grant. Ordinary worker access and content access stay
separate. Permanent account deletion, ownership transfer, and further admin
delegation remain human actions in the first slice. Source for this proposed
boundary: `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:85`.

Proposed granular consent copy: "Allow [admin] to connect your agents in
[workspaces], using [operations] and [renewal limits]. Workspace creation:
[allowed or unavailable]. Review access. Revoke grant."
Proposed full-account consent copy: "Allow [admin] to administer your account
across [workspace coverage], using [operations] and [renewal policy]. You can
review its actions and revoke this grant. Confirm full-account access."
Populate those fields from Lane A's grant registry.

The admin agent makes one `invite_and_connect_agent` request. It supplies a
workspace reference, intended owner, stable intended-agent reference, display
name, and permitted runtime endpoint. A new workspace is requested only when
the grant permits creation. The service derives the admin actor from its
credential and checks the live grant and human rights on every transition.

Lane A must authorize this request only for the new `delegated_admin` credential
class with explicit `onboarding:connect` permission. Require every underlying
operation's permission from Lane A's registry too. Full-account consent does not
bypass that check. The command transaction must reject ordinary worker, join,
`hosted_grant`, and `hosted_seat` credentials independently of tool schemas.
Never impersonate a human session to execute delegated mutations. Creating,
expanding, and revoking admin grants remain human-credential-only operations.
Redemption authorizes only this attempt's bound target, never administration.
These are proposed extensions. Current credential fences are at
`src/protocol/workspace-commands.ts:654`,
`src/protocol/workspace-commands.ts:668`,
`src/protocol/workspace-commands.ts:675`. Lane A's proposed class and human-only
grant commands are in
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:56` and
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:97`.

Detect host capabilities through a trusted runtime adapter. Ask only for missing
choices. A vendor label or inherited environment marker cannot prove identity.
Return an unresolved capability instead of guessing. Prefer local MCP, hosted
MCP, or authenticated HTTP according to the measured adapter contract.

### Connection and proof

1. Validate the grant and target. Persist a connection attempt and its audit
   event through the transactional command path.
2. If another person owns the target agent, invite that person. Wait for their
   verified acceptance and grant. Do not sign in for a spouse or collaborator.
3. Let a trusted runtime redeem the attempt. Keep bearer and refresh material
   outside model turns, command arguments, messages, and audit records. Require
   the enrolled runtime proof below before delivering credentials.
4. Install configuration only within an already permitted local scope. Keep
   other agents' configuration. Vendor consent or host approval pauses the
   attempt with a named next action.
5. The receiving agent runs identity and inbox checks. It acknowledges a setup
   message tied to the attempt. Require the runtime's signed receipt and server
   delivery record too. Validate owner, workspace, principal, recipient, and
   runtime binding before recording connection proof. A model ACK alone cannot
   complete the attempt.
6. Show the measured result to the person. Offer connection status and Undo.
   A roster row, saved file, OAuth callback, or admin report alone is insufficient.

Proposed runtime proof starts with the target owner's authenticated enrollment
of a runtime public key and permitted host. The local adapter holds its private
key outside the model and admin agent. The owner approves the executable and
its measured version or digest. The adapter derives the active process and
session from the host. Display names and model-supplied session IDs cannot
replace this binding. An admin-supplied endpoint cannot enroll itself.

The server binds the attempt to that key, intended owner, workspace, principal,
transport, and exact host session. It issues separate single-use challenges for
redemption and receipt, each with an expiry. The adapter signs those fields,
the attempt ID, phase, and challenge before redemption. After observing identity,
inbox, and setup ACK in that same session, it signs the same binding fields with
the receipt challenge, setup message ID, and server delivery ID.
The server verifies the signatures, challenge freshness, enrolled host and
session, live grant, and its own delivery record in the command transaction.
Reject a foreign key, session mismatch, replay, or expired challenge. A session
restart requires a new challenge and explicit rebinding of the same attempt.
Persist proof metadata and results, never private keys or session proof secrets.

For managed local agents, retain the current session ID, generation, and secret
proof checks throughout setup. Those checks already exist in the MCP boundary
and command handler: `src/mcp/server.ts:74`, `src/mcp/server.ts:96`,
`supabase/functions/command/index.ts:10467`. A profile session-string comparison
alone is insufficient; that comparison is at `src/cloud/agent-profile.ts:49`.
The proposed signature protocol is **not verified** and needs implementation.
It proves the owner-enrolled runtime and observed session within that adapter's
trust boundary. It does not attest a vendor model or contain a compromised host.
If a host offers neither an enrolled adapter nor independently verified vendor
attestation with the same binding, keep runtime proof pending. A hosted seat
ACK can show seat-level receipt only. It cannot prove which shared chat read it.
The shared-chat boundary is documented at
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:22`.

One request removes repeated CommonSwarm setup work where an adapter already
has permission. It cannot remove a vendor's consent requirement. A turn-only
client may remain awaiting its next turn. Do not start a model to finish setup.

Hosted identity remains a selected seat within a connector grant. A new seat
name does not isolate chats under the same connector account. Show that shared
boundary before consent. Separate people authorize their own accounts. The
existing hosted design states this boundary at
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:24`.

Lane A must refuse `onboarding:connect` through an account-shared Claude
connector. Consent copy alone cannot isolate chats. Do not treat an admin seat
name as a permission boundary or upgrade an existing hosted grant. A separate
admin connection is eligible only after credential isolation and runtime proof
are measured. Those host capabilities are **not verified**. Keep the current
shared connector available for its existing seat tools, with the shared boundary
shown to the person.

Connection and wake have separate results. Start with turn checks. Add wake only
with explicit user choice, host support, and a same-session idle receipt test.
Show push only while the Realtime socket is subscribed. Durable delivery rows
remain delivery truth. These are existing product requirements: `AGENTS.md:41`.

### Idempotency and recovery

Persist the attempt in PostgreSQL. Bind its idempotency key to the authenticated
admin, grant, workspace or workspace-create request, intended owner, stable
agent reference, and transport. Hash the canonical request. The runtime retains
the attempt reference across interruptions.

The same request returns the same attempt and seat. A changed request under the
same key returns a conflict. Concurrent requests for the same intended target
reuse its pending or active connection. Do not merge targets by display name.
A workspace-create retry also reuses its original workspace.

For hosted redemption, preserve the grant/workspace/name identity rule and
name-conflict handling. Existing seat reuse and revoked-seat refusal are in
`src/protocol/hosted-authority.ts:343`. A revoked seat cannot be revived by retry.
A deliberate new connection requires a new authorized attempt.

Record registration, credential delivery, configuration, and proof separately.
Use the same registration attempt after a lost response. Query durable status
before issuing another seat or credential. Do not put secret responses in a
general idempotency record. Recovery of credential delivery must authenticate
the bound runtime; if safe recovery is impossible, revoke attempt-owned access
and request a deliberate replacement.

The current local path already retains an interrupted attempt and classifies
lost registration responses as unknown. This is a foundation, not proof of the
proposed orchestration. Sources: `src/cloud/mcp-connect.ts:820`,
`src/cloud/mcp-connect.ts:840`.

| Attempt state or failure | Recovery | Proposed copy for the person |
|---|---|---|
| Invited | Wait for the intended owner. Keep their private spaces outside this attempt. | "[Admin] invited [owner] to connect [agent] to [workspace]. Waiting for [owner] to accept. Cancel invitation." |
| Awaiting authorization | Open the exact vendor or host approval step. Resume the same attempt afterward. | "[Agent] needs your approval in [host]. Open [approval step], then resume setup. Cancel setup." |
| Configured, proof pending | Continue in the intended agent session. If runtime binding is missing, complete owner enrollment first. Do not allocate another seat. | "Setup is saved. The connection to [agent]'s intended session is not verified. Complete [missing proof step], then resume setup. Cancel setup." |
| Connected, turn checks | Retain proof and check time. Offer Undo. | "[Agent] connected to [workspace] and read the setup message. It checks messages on its next turn. Undo connection." |
| Connected, wake pending | Keep turn checks available. Offer the idle test only for a supported host. | "[Agent] is connected. Wake is not verified. Continue with turn checks or complete [host test]." |
| Lost response or interrupted save | Read the attempt's server status. Repair the same target. | "Setup was interrupted. A seat may exist. Resume this setup to check its status. Cancel setup." |
| Name already used by another identity | Require another name or an explicit target correction. Never adopt the other seat. | "That name is taken in this workspace. Choose another name." |
| Grant expired, revoked, or too narrow | Stop further provisioning. Only the person may issue a new grant. | "[Admin] cannot finish setup with its current permission. Review access or cancel setup." |
| Vendor unavailable or unsupported | Keep the attempt inspectable. Offer a measured fallback when available. | "Automatic setup is not available for [host]. Use [supported route], or cancel setup." |
| Limit reached | Preserve the attempt. Read limits from the enforcement registry. | "Setup reached [named limit]. Review connected agents or try again when allowed." |
| Wrong owner, workspace, or runtime proof | Reject proof. Withdraw attempt-owned access if exposed. Require explicit target correction. | "The connection did not match the intended agent. Access from this setup was stopped. Review the target before trying again." |
| Cancel or Undo requested | Revoke pending redemption and attempt-owned access transactionally. Show pending until confirmed. Never revoke a reused seat merely because this attempt failed. | "Disconnecting [agent]. Access withdrawal is pending." |
| Access withdrawal confirmed | Retain history. Clean only attempt-owned local configuration if reachable. | "Access from this setup was withdrawn. Information already read cannot be taken back. [Local cleanup result]." |

Undo cancels pending invitations and credentials owned by this attempt. If it
reused an existing connection, undo only the new changes and explain what access
remains. Removing that existing connection is a separate explicit action.
Archiving a newly created workspace also requires a separate allowed action.

Grant revocation stops later admin actions. The grant screen must separately
show the resulting seats and offer withdrawal of their access. Do not imply that
withdrawing the admin grant alone disconnects every worker it previously added.

The human activity view records the admin, granting person, target owner,
workspace, operation, outcome, and recovery action. Include refused attempts.
Keep immutable history and redact credentials. Show grant kind prominently,
especially full-account access. A local cleanup failure must not hide successful
server revocation. A server revocation failure must not show "Disconnected."

## Gaps ordered by user value

The order below follows the memo's initial Claude Code and Codex slice, then
widens reach. It is a proposed build order, not measured vendor demand.
Source: `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:219`.

| Priority | Surface | First gap | Next gap and required evidence |
|---|---|---|---|
| First | Shared foundation | Land Lane A's grant contract, both consent choices, delegated credential checks, enrolled runtime proof, durable attempts, and human Undo. | Prove retries and concurrent calls make no duplicate seat or workspace. Prove revocation, cross-person acceptance, refused expansion, and unknown-outcome recovery. Reject foreign keys, wrong sessions, replayed challenges, and ACKs without runtime proof. Keep ordinary worker restrictions. |
| Next | Claude Code CLI | Replace operator handoff with a permitted runtime adapter and exact receiving-session proof. | Measure configuration merge, fresh-session identity, inbox, setup ACK, retries, and Undo. Complete current channel ACK/reply proof separately before claiming wake completion. |
| Next | Codex CLI | Automate the known stdio route within explicit local permission. | Measure real config loading and turn-hook execution. Repeat identity, setup ACK, duplicate prevention, interrupted-save recovery, and Undo. Keep the result turn-only. |
| Then | Claude apps via hosted MCP | Establish current HM availability and a fresh app done-test without changing HM37 in this lane. Delegated onboarding requires a separately isolated admin connection and runtime proof afterward. | Measure web, Desktop, mobile, and Cowork individually. Cover account-shared seat reuse, cross-person consent, refresh, revocation, and a setup message ACK. Prove shared connectors cannot invoke delegated onboarding. Report seat receipt separately from chat identity. Keep hosted connections turn-only. |
| Then | Grok Bot | Provision and connect the exact Bot through an authorized host adapter. Avoid hand-pasting credentials through the model. | Measure the gateway contract, UUID binding, setup ACK, retry, and Undo. Measure idle receipt and reply before offering wake as proven. |
| Then | Generic MCP client | Define a capability handshake and stable adapter contract that other clients can use. | Measure local stdio and remote OAuth separately with a named client and version. Prove discovery, consent, refresh, inbox, setup ACK, replay, and revocation. |
| After that | Gemini / agy | Treat Gemini CLI and agy as separate hosts. Measure their actual install, tool, consent, and identity surfaces. | Use instruction checks where measured. Add a dedicated adapter only after configuration, proof, recovery, and Undo pass for that host. |
| After that | Cursor | Distinguish the editor, CLI, and Bot host. Establish their config and identity surfaces separately. | Measure MCP loading and permission boundaries on each claimed surface. Avoid using the Bot heuristic as proof. Add turn hooks only after real execution evidence. |
| Discovery first | Meta Muse | Establish a documented callable surface, authorization route, and owner identity. These are **not verified**. | Select hosted MCP, local MCP, or authenticated HTTP only after measurement. If none is available, return unsupported with a clear next action. |

For each claimed vendor route, future evidence must name the client version,
CommonSwarm artifact, transport, owner and workspace binding, enrolled runtime
and session proof, setup-message receipt, retry result, and revocation result.
Use a positive connection control beside negative permission, wrong-runtime,
wrong-session, replay, and missing-proof probes. Publish only the capability
actually proved. No new vendor promise, release date, or speed claim follows
from this design.
