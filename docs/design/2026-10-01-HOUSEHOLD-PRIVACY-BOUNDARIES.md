# Household privacy boundaries and workspace templates

Date: 2026-10-01. Status: proposed design for Lane P2, before code.

Source review uses repository commit `4d6a06509f9abf1aefac8c88ec00280d025df673`.
Current behavior below means checked-in source or documented policy.
Production behavior, browser behavior, and vendor compatibility are **not verified**.
No tests were run and no services were contacted.

## Direction and scope

CommonSwarm should support separate people coordinating through their agents.
Personal records, shared household records, and business records need separate boundaries.
Bookkeeping is one example of shared context, not a proposed product feature.
These premises come from `/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:4`
and `/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:7`.

Tom chose both granular administration and an optional full-account grant.
Granular is the default. It selects workspaces, operations, and renewal limits.
Workspace creation is a separate permission.
Full-account access needs explicit human confirmation, visibility, revocation, and audit.
This later decision replaces the memo's choice between A and B.
Source: `/Users/yulanbot/work/cswarm-vision/lanes/task-p2.md:3`.

This document specifies privacy and templates. It proposes no change to HM37.
Templates come first, using separate workspaces and synthetic records.
General content grants, complete access audit, hosted content tools, tasks, and calendar
need later implementation and review. This follows the phased scope in
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:220`
and `/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:226`.

## Current boundaries and required additions

| Current source or policy | Consequence for this design |
|---|---|
| A workspace has no private area or per-record permission. Directed signals have a visibility exception. `SECURITY.md:43`. | A personal space must initially be a separate workspace. An invitation to a shared workspace must explain its broad content boundary. |
| Workspace members have human user IDs. Agent principals have an owner user ID. `src/protocol/workspace-events.ts:73`, `src/protocol/workspace-events.ts:95`. Local principal creation stamps that owner from the caller. `src/protocol/workspace-commands.ts:987`. | Each person keeps their own human identity and owns their agents. A household is not a shared login. |
| Local agent reads compare the requested workspace with the principal's workspace. Foreign-workspace file reads return an empty list. `supabase/functions/read/index.ts:548`. | Connect an agent separately to each approved workspace. A workspace name or copied file ID cannot serve as permission. |
| Channels address signals and do not grant read access. `src/cloud/command-client.ts:170`. | A channel called Personal or Finance cannot isolate records. |
| Workspace creation, invitations, membership changes, and agent provisioning are human-only commands. The reducer checks credential kind. `src/protocol/workspace-commands.ts:410`, `src/protocol/workspace-commands.ts:675`. Ordinary agent tokens have an explicit administration denylist. `docs/design/SWARM-CLOUD.md:125`. | Delegated administration is new work. Amend the canonical specification before implementing it. Keep ordinary worker permissions separate. |
| An owner or admin may revoke another member's agent inside that workspace. A plain member may revoke only their own. `src/protocol/workspace-commands.ts:997`. | Keep other household members out of a person's private workspace by default. Household administration must not imply administration of that private space. |
| File metadata is listed through a membership-gated workspace view. Creator and uploader fields are included. `supabase/functions/read/index.ts:822`. File commands bypass the ordinary per-scope gate. `supabase/functions/command/index.ts:10843`. | Existing file access is not selected-record access. New content grants must cover commands, metadata, and storage bytes together. |
| The brain maps topics into file names and derives its list from files. `src/cloud/brain.ts:66`, `src/cloud/brain.ts:115`. | Wiki pages inherit the file boundary. A topic prefix is organization, not privacy. |
| Hosted seat commands and reads have narrow allowlists. `supabase/functions/_shared/hosted-seat-auth.ts:6`, `supabase/functions/_shared/hosted-seat-auth.ts:7`. The hosted tool table contains no file or wiki tools. `supabase/functions/mcp/tools.ts:28`. | Hosted files and wiki require a separate extension. Do not promise sensitive content access through the current hosted tools. |
| Signals, coordination events, and audit records cannot be edited or deleted through the application. `SECURITY.md:46`. | Keep sensitive bodies out of immutable history. Corrections must not be described as erasure. |

The canonical command contract derives the actor on the server and checks workspace
permission inside the transaction. It appends events and updates projections.
`docs/design/SWARM-CLOUD.md:85`.
The workspace adapter calls the decision core, then records accepted or domain outcomes
in audit. `supabase/functions/command/index.ts:12412`,
`supabase/functions/command/index.ts:12664`.
Proposed grants, consent changes, and revocations must use that transactional path.
Store durable permission state in PostgreSQL, as required by `AGENTS.md:39`.

## Per-person spaces and explicit sharing

The rules in this section are proposed requirements.

Each person starts with a personal workspace containing only that person.
Adding their own agent is an explicit connection choice.
Creating a household workspace does not invite anyone to personal workspaces.
Marriage, employment, shared billing, and workspace administration imply no private access.
An agent must not read another person's space without that person's explicit grant.
The granting person must also have the right to share the selected material.

With current boundaries, adding a person to a source workspace discloses its workspace
content, subject to directed-signal filtering. `SECURITY.md:43`.
For selected disclosure, the initial template must instead use a separate destination
workspace containing only material chosen for that audience.
This is a sharing pattern, not a claim that selected-record grants already exist.

The sharing flow must show the source, recipient, destination, selected fields, and
whether attachments or history are included. Nothing is preselected from private content.
Show a preview and obtain the source person's confirmation before disclosure.
An agent may repeat a sharing action inside an existing, explicitly bounded content grant.
Messages and wiki text cannot create or enlarge that grant.

Share a redacted snapshot by default. Do not synchronize future changes automatically.
Record who selected it, its source version, the recipient, and the sharing decision.
Keep private source titles and identifiers out of the destination's visible provenance
when those details would reveal excluded information. Retain the full mapping privately.
Revoking the source grant stops later sharing. It cannot retract a destination copy
already disclosed. The sharing preview must explain that difference.

Keep a separate principal and connection for each intended workspace and purpose.
Do not give a shared household worker the credentials used by a person's private worker.
Keep private and shared runtime context, caches, and transcripts separate too.
Separate credentials alone cannot remove private material already in an agent's context.
Human and agent membership choices must appear separately in template setup.
An invitation to another person's agent requires that person's acceptance and permission.
Do not authorize their vendor account on their behalf.

Hosted seats also need a clear boundary statement.
The approved brief defines a seat as a reusable identity selected by a chat.
All chats on the connector account share its grant and can select its seats.
Separate seat names do not isolate those chats.
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:22`,
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:24`.
The checked-in adapter resolves seats using the grant and handle, without a chat identity.
`supabase/functions/_shared/hosted-seat-auth.ts:107`.
Actual vendor behavior is **not verified** here.
Where chat isolation is needed, use separate connector accounts with separate grants.
If a vendor cannot provide that boundary, omit private spaces from that connection.

## Administration and content are separate grants

Existing `enable_agent_management` concerns execution-session protection for a principal.
It sets `managed_at` and an execution-session row.
`supabase/functions/command/index.ts:13747`,
`supabase/functions/command/index.ts:13763`.
The command path checks session proof for managed local agents.
`supabase/functions/command/index.ts:10467`.
This does not grant workspace administration. Enabling management remains human-only.
`src/protocol/workspace-commands.ts:424`, `src/protocol/workspace-commands.ts:675`.

These are proposed requirements for both administration choices.

Granular administration names the agent connection, selected workspaces, allowed
operations, target owners or seats, expiry, and renewal limits.
Workspace creation must be chosen separately. Created workspaces start private.
Permission to create a workspace does not permit sharing its content.

The optional full-account grant covers the defined administration operations across
the granting person's existing authorized workspaces, shown individually at consent.
Future workspaces are excluded until the person explicitly adds each one.
Creation permission does not enroll a new workspace in the administration grant.
Personal spaces require a separate human choice naming that workspace and connection.
Adding a workspace never grants content access or provisions an agent into it.
It must show a persistent full-account label and a human-accessible revoke action.
It cannot grant rights in another person's private workspace or exceed the grantor's rights.
Do not silently upgrade a granular grant or an existing worker connection.

Full-account describes workspace breadth. It is not an unbounded operation wildcard.
Use one operation registry for both grant choices, consent, and server checks.
Operations absent from that registry are refused. New operations require new human consent.
The initial contract must specify these high-impact decisions:

| Existing operation to extend | Proposed delegated limit |
|---|---|
| `invite_member` | Human confirmation for each invitation, naming workspace, recipient, role, and the content disclosed on acceptance. The invitee still accepts as their own identity. |
| `change_role` | Human confirmation for each non-owner role change, naming target and before/after rights. Owner changes remain human-only. |
| `remove_member` | Human confirmation for each non-owner removal. The agent cannot remove the grantor. Owner removal remains human-only. |
| `mint_agent_join_credential` | Human confirmation for each issuance, naming workspace, intended owner, recipient runtime, seat limit, expiry, and resulting content access. Redemption must stay within that confirmed choice. |
| `mint_agent_token` | Human confirmation for each issuance, naming principal, scopes, expiry, renewal limits, and resulting content access. Never mint delegated administration credentials through this operation. Routine worker renewal remains a separate bounded successor operation. |
| `revoke_agent_principal` and credential revocation | Only explicitly named targets. Revoking a grantor-owned principal or credential requires human confirmation for that target and action. Protected recovery access cannot be revoked by the delegated agent. |

Membership changes, initial token issuance, and principal revocation currently require
human credentials. The reducer lists them and checks credential kind.
`src/protocol/workspace-commands.ts:410`, `src/protocol/workspace-commands.ts:675`.
The join-credential handler also checks for a human user credential.
`supabase/functions/command/index.ts:6869`.
The canonical policy forbids ordinary agent administration and sibling revocation.
`docs/design/SWARM-CLOUD.md:125`.
Its worker renewal contract is a separate successor operation.
`docs/design/SWARM-CLOUD.md:126`.
These proposed delegated limits require a reviewed canonical amendment before code.

Every confirmation above must be visible to the human and bound server-side to that
single action, target, and permission change. Recheck rights when the action executes.
Initial full-account consent and a prior sharing policy cannot replace that confirmation.
Messages, files, and agent-generated instructions cannot supply human confirmation.
This preserves the visible gate for membership and credential decisions in
`docs/design/SWARM-CLOUD.md:63`.

The proposed administration credential must not itself authorize content reads or exports.
This is a new separation, not a guarantee of current workspace membership.
Today, membership exposes workspace content except directed signals. `SECURITY.md:43`.
Invitations and agent provisioning must therefore be treated as content-sharing actions.
Show the whole workspace disclosure, including files, wiki, and available history.
For selected material, use a separate destination workspace until content grants exist.
A role change must show any new sharing or administration rights.
An agent may not create further administration grants or widen its own content grant.

Current principal revocation permits an owner or admin to revoke another member's agent.
It does not protect the caller's own other principals from that caller.
`src/protocol/workspace-commands.ts:997`, `src/protocol/workspace-commands.ts:1005`.
The new delegated path must preserve the grantor's human login, membership, grant-revoke
action, and designated recovery principals and credentials outside agent revocation scope.
It must not disable their managed-session protection or remove the last independent
recovery route. A full-account choice cannot waive these requirements.

Record grant creation, changes, expiry, renewal, revocation, and administration outcomes.
Show who granted access and what remains permitted. Losing the grantor's underlying rights
must stop subsequent agent calls. Refresh must preserve or narrow permission.
Revocation must remain available when the agent or its setup fails.

## Synthetic workspace templates

All names and records below are invented. Templates supply structure and sample text.
They must not import real documents or connect external accounts automatically.
The examples illustrate proposed defaults, not shipped templates.

| Template | Synthetic structure and example | Default sharing |
|---|---|---|
| Personal | Alex's Personal workspace. A private travel draft and a wiki page for personal preferences. Jordan has a separate Personal workspace. | Only the named person. Their agents require explicit connection. No household or business invitation. |
| Household | Alex and Jordan's Household workspace. A shopping list, a repair estimate, and a shared trip plan. | Invite the selected people only after confirmation. Each chooses their own agents. Personal wiki pages and private appointment details stay in personal spaces. |
| Household project | A separate Guest Room Repair workspace. Share the chosen estimate and work instructions with a fictional contractor. | The contractor sees only the copied project material. No membership in the main household or personal spaces. Revoke project access when the collaboration ends. |
| Small business | Harbor Studio workspace. A project brief, supplier quote, and wiki page for agreed working practices. | Selected business members and their approved agents. Household records stay separate. Use a separate collaborator workspace for selected disclosures until content grants exist. |
| Business external review | Harbor Studio Review workspace. Copies of selected, redacted records for a fictional outside adviser. | No access to the source business workspace. Future selected-record grants should be named, read-only, time-limited, and revocable. Export needs a separate choice. |

Template setup must name the owner and show who will read each destination.
Do not make another person an owner or admin automatically.
The canonical policy requires at least two Owners from collaborator-onboarding acceptance.
`docs/design/SWARM-CLOUD.md:163`.
Shared templates must obtain explicit choices for those human Owners before onboarding
collaborators. An agent seat cannot serve as the second human Owner.
Do not invite someone into a personal space to satisfy a shared template's owner choices.
A shared workspace owner manages that workspace, not its members' private spaces.
Labels such as Sensitive or Personal must never imply an extra technical boundary.

Bookkeeping is one illustrative use of these same primitives.
Alex could share a redacted receipt and a proposed expense category in Household.
Harbor Studio could share selected invoices with an accountant's agent in Review.
Keep household and business records separate. Preserve source and review status.
This adds no bank connection, money movement, financial advice, or accounting feature.

## General content grants and access audit

These are new requirements. They do not describe current accepted scopes.

A content grant must bind a granting person, named recipient or agent connection,
workspace, selected records or folder, operations, expiry, and revocation state.
For a hosted connection, consent must name the connector grant's shared boundary.
It must not imply that a seat name restricts other chats on that grant.

Define operations separately: read, add, update or annotate, categorize, and export.
Read-only access permits none of the write operations.
Adding a record does not grant access to unrelated existing records.
Categorization changes need attribution and a visible review status.
Version history and future versions require explicit inclusion.
Folder grants should cover a selected snapshot by default.
Following new records in that folder needs a separate, visible choice.
Field selection must produce a redacted view or copy before content leaves the server.

Use one permission registry for server checks, tool schemas, consent, and help.
Check the durable grant on every operation, including listing, search, previews, links,
wiki reads, version access, downloads, and export jobs.
No alternate human, local-agent, hosted-agent, or storage route may bypass the restriction.
Hidden content must not leak through names, counts, excerpts, attachments, or errors.
Cross-workspace references must be authorized at resolution, not merely at link creation.

External collaboration defaults to selected material, read-only access, and an expiry.
Export is a separate permission for bulk or packaged retrieval.
Reading bytes still allows a recipient to save or repeat them.
Do not promise that withholding export prevents copying.
Show that limitation before the person grants access.

The canonical spec says file-list reads and signed GET transfers are not audited per
principal. Download-URL creation is audited. `docs/design/SWARM-CLOUD.md:194`.
Current bytes travel directly through signed storage URLs.
`supabase/functions/command/file-artifacts.ts:21`.
Tombstoning refuses new download URLs but existing URLs expire on their own clock.
`supabase/functions/command/file-artifacts.ts:1036`,
`supabase/functions/command/file-artifacts.ts:1187`.
Complete access audit and immediate withdrawal of outstanding byte access are therefore
new work. Actual storage-download coverage is **not verified**.

Before sensitive external access, provide an authenticated transfer route that checks
the grant at use and records the transfer. URL issuance alone cannot prove a read.
Revocation must stop subsequent requests, queued exports, and renewed access.
Define what happens to an in-flight transfer and show the measured result.
No system can retract bytes already delivered or knowledge retained by an agent.

The owner-visible audit must distinguish attempted, refused, authorized, and completed
operations. Record actor, owner, connection, grant, resource version, operation, server
time, and result. Record grant changes and selected disclosures too.
Logs must contain no credentials, raw document bodies, or forbidden identifiers.
Private-space audit belongs to that person's boundary.
A household admin must not receive another person's private titles or access history.
An unavailable required audit write must refuse sensitive access before disclosure.

## Sensitive data, retention, and export

These are proposed lifecycle requirements.

Never store full card numbers, full account numbers, credentials, or government IDs.
Use a safe reference or last four digits only when needed.
Credential references must contain no credential value. A reference is not a login.
This rule applies even with owner permission or a full-account grant.
It is stricter than the memo's suggested government-ID exception.
Source requirement: `/Users/yulanbot/work/cswarm-vision/lanes/task-p2.md:9`.

Apply minimization to uploads, images, extracted text, metadata, messages, wiki pages,
tasks, calendar entries, logs, previews, and exports.
Redact before upload or before writing immutable text.
Flag records with health, school, financial, or identifying details for explicit sharing.
Collect only the fields needed for the stated purpose. Do not ingest a whole transcript
because one fact in it would be useful.

The canonical spec documents no upload-side secret screening.
`docs/design/SWARM-CLOUD.md:194`.
Automatic sensitive-data screening or complete redaction is **not verified**.
Warnings alone cannot establish that an upload is safe.
Use synthetic content for template evaluation. Sensitive use needs reviewed intake rules
and a defined incident path before it is offered.

Proposed incident handling must withdraw access, disable new links, identify disclosed
copies, and notify the affected owner without repeating the sensitive value.
Replacing a file or adding a corrective message must not be called deletion.
Deletion must distinguish current bytes, older versions, derived text, exports, and history.

The current file path returns a restoration deadline after tombstoning.
`supabase/functions/command/file-artifacts.ts:1173`.
Its purge consumer deletes queued storage objects on a best-effort basis after file
commands. `supabase/functions/command/file-artifacts.ts:1291`.
The canonical spec describes live-file retention until tombstone and a later purge queue.
`docs/design/SWARM-CLOUD.md:194`.
Actual purge completion and backup retention are **not verified** here.

Offer retention choices by workspace and record class before enabling sensitive records.
Do not invent a retention duration in a template.
Specify expiry of pending uploads, retired versions, extracted text, temporary exports,
and backups. Show what remains in immutable audit or coordination history.
Keep minimal provenance after content deletion, without retaining private content in logs.
Account closure needs a separate reviewed procedure for shared ownership, pending exports,
retained history, backup expiry, and deletion receipts.

Provide an owner export and a separately granted collaborator export.
Each export must check current permission when requested and when retrieved.
Include only authorized fields, versions, files, wiki pages, messages, and audit records.
Preserve provenance, timestamps, review status, and redaction notes in a portable manifest.
Exclude credentials and forbidden identifiers. Private source references stay private.
Disclose the destination and the included material before release.
Audit completion, expire temporary artifacts, and cancel pending jobs on revocation.
A complete household export and account-closure flow are **not verified**.

## Hosted files, wiki, tasks, and calendar

The proposed hosted file and wiki extension must use the same content grants as local
and human access. It needs bounded uploads, version choices, conflict handling, and
owner-visible results. Treat uploaded instructions as content, not permission.
Do not copy a private brain page into a shared brain without a sharing decision.
Do not let search or an agent summary combine differently shared sources into a broader
audience. The resulting summary needs its own authorized destination.

The CLI exposes brain version selectors, and the file handler checks tombstones before
issuing download URLs. `src/cloud/brain.ts:48`,
`supabase/functions/command/file-artifacts.ts:1090`.
Future content grants must cover older versions and derived material too.
Updating the latest page cannot hide a forbidden value retained in history.

The existing protocol has task creation, leases, handoff, submission, close, and reopen.
`src/protocol/commands.ts:20`.
Consumer task and calendar behavior is **not verified**.
Later design must reconcile household follow-through with those task semantics.
Signals remain coordination messages and do not close tasks. `AGENTS.md:16`.

Tasks need an owning person, workspace, assignee consent, permitted readers, due dates,
and authorized links to supporting records. A shared reminder must not expose a private
task title or document. Completing a shared task must not publish its private evidence.
Calendar needs separate detail and availability permissions, attendee consent, time zones,
recurrence, cancellation, reminders, and export choices.
A busy interval should disclose no private appointment details by default.
External calendar adapters require their own bounded grants and revocation behavior.

## Review and implementation sequence

Start with synthetic templates over separate workspaces.
Review consent and sharing copy alongside the delegated-administration contract.
Amend the canonical human-only rules before adding delegated administration.
Then implement general content grants, byte-access checks, and complete access audit
together with hosted files and wiki. Resolve lifecycle rules before sensitive use.
Tasks and calendar follow their own design review.

Future verification must prove separation using authorized positive reads alongside
refused cross-person reads. Cover local credentials, hosted grants, metadata, history,
search, byte retrieval, exports, membership changes, expiry, and revocation.
Use synthetic records and separate connector accounts where isolation is required.
These are review requirements, not tests run by this lane.

This document implements no permissions or lifecycle behavior.
HezLead arranges the independent check and subsequent implementation lanes.
