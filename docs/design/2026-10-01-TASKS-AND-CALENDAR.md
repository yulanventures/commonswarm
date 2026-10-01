# Tasks and calendar

Date: 2026-10-01. Lane P4. Proposed design, before implementation.
Source review: checkout `0229f5a7bc2f9e9891164893348e1d459776d855`.
Runtime behavior, production state, scheduler capacity, and vendor wake are **not verified**.
No tests were run and no services were contacted. This document changes no HM37 work.

All requirements below are proposals unless labelled as checked-in behavior.
The canonical specification still wins. Its task and close rules need a reviewed amendment
before the proposed planning behavior can ship. Sources: `AGENTS.md:34`,
`docs/design/SWARM-CLOUD.md:95`, `docs/design/SWARM-CLOUD.md:131`.

## Product contract

The product has Messages, Files, Wiki, Tasks, and Calendar, with a screen for each.
Tasks record follow-through. Calendar shows those same tasks at scheduled times.
A task has a name, an owner who is a person or agent, a state, an optional due date,
and links to messages and wiki pages. Lists and boards are views over history.
These are roadmap requirements, not claims about shipped consumer features.
Source: `/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:91`.

Personal, household, and business use share these primitives. Bookkeeping adds no
special task type or accounting workflow. Sources:
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:5`,
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:7`.
Tasks and calendar follow the connection and privacy foundation. They are outside
the memo's initial implementation slice. Sources:
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:226`,
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:259`.

## Checked-in foundation and gaps

| Source | Checked-in behavior and implication |
|---|---|
| `src/protocol/events.ts:118`, `supabase/migrations/20260723000001_p1_schema.sql:309` | `TaskState` already carries task ID, slug, lifecycle, version, epoch, owner, lease expiry, submission, and close disposition. The projection key is `(stream_id, task_id)`. Extend it. |
| `src/protocol/events.ts:20`, `src/protocol/events.ts:27` | Actors carry human, agent, and run identity. Ownership compares the agent principal when present, otherwise the human user. A run is not a task owner. |
| `src/protocol/workspace-events.ts:106`, `supabase/functions/_shared/agent-auth.ts:111` | Token state carries run, nullable task, and nullable epoch fields. The local credential loader joins the actual run. That loader does not select task or epoch. Carrying those fields does not prove task-bound authentication. |
| `src/protocol/commands.ts:20`, `src/protocol/events.ts:108` | The core has create, acquire, renew, handoff, takeover, submit, close, and reopen. Its lifecycle is open, active, awaiting_review, reopened, or done. There is no dropped state in this type. |
| `src/protocol/commands.ts:185`, `src/protocol/commands.ts:195` | Submission requires a live owner lease and evidence. Close requires a frozen submission and checks its epoch. A household Done button cannot call close without that contract. |
| `src/protocol/reducer.ts:85`, `src/protocol/reducer.ts:126` | A frozen submission survives reacquisition. Reopen clears submission and lease ownership while retaining the monotone epoch. Preserve those semantics. |
| `supabase/functions/command/index.ts:12584`, `supabase/functions/command/index.ts:12595` | Task events are appended before the task projection is updated on the command path. New changes must use that path. |
| `supabase/functions/command/index.ts:9304`, `supabase/functions/command/index.ts:11580` | Messages are inserted into `swarm.signals`. Their response has no canonical event IDs. Tasks and messages do not yet share a physical event log. |
| `supabase/migrations/20260724000003_signals.sql:36` | Signal update and delete operations hit an append-only trigger. Log reconciliation must preserve existing messages. |
| `supabase/migrations/20260731000001_signal_deliveries.sql:15`, `supabase/migrations/20260906000010_wake_delivery.sql:150` | Agent delivery rows have recipient identity and receipt state. Inserting one triggers a content-free Realtime wake. Use this delivery path for assignment and calendar notices. |

## One task object

Keep the existing workspace, stream, and task identity. Links name that full identity.
Do not create a consumer-task table, a second task ID, or a calendar-event ID.
A scheduled task remains the same task when read from either screen.
This implements the reuse rule at
`/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:106`.
The existing composite key is at
`supabase/migrations/20260723000001_p1_schema.sql:322`.

Proposed additions belong to the existing task projection and its events:

| Field | Proposed meaning |
|---|---|
| `name` | Bounded display text. Keep `slug` as its stable existing reference. Old tasks may display their slug until named. |
| `completion_policy` | Immutable choice at creation: `planning` or `governed`. Existing histories default to governed. Both use the same task ID, reducer, log, and read model. |
| `owner` | Reuse the existing field. Resolve it to a current human member or agent principal in the task's workspace. Preserve its identity kind in event payloads and reads. Planning acceptance may populate it while the task stays Open. Governed ownership remains lease-derived. |
| `due` | Optional date, or an instant with its time zone. A due date is a deadline. It does not imply a wake time. |
| `links` | Typed message and wiki references. Resolve each target under the reader's current permission. Never copy private bodies into task history. |
| `schedule` | Optional start, end, IANA time zone, all-day date interval, and selected attendees. This is the calendar object within the task. |
| `assignment_offer` | Optional pending recipient and consent reference. The proposed recipient is not the accepted owner. |
| `last_task_seq` | Rebuildable cursor of the last task mutation in its stream. Used for conflicting edits. It does not replace lease epoch or the existing task version. |

The policy split is a proposed amendment to the evidence rules at
`docs/design/SWARM-CLOUD.md:131` through `docs/design/SWARM-CLOUD.md:146`, and the
task and lease contract at `docs/design/SWARM-CLOUD.md:95`.
It avoids fabricated branches, SHAs, or evidence for
ordinary planning. Existing close rules remain on governed tasks.
There is no policy conversion in v1. A planning task cannot establish that code landed,
a release succeeded, or evidence was accepted. Those require a governed task and its gates.

Keep actual run IDs in actor provenance. Do not manufacture a run to assign a person,
schedule an appointment, or send a reminder. Preserve the task version's reopen meaning.
Sources: `src/protocol/events.ts:34`, `src/protocol/events.ts:122`.
The checked-in `epoch` is a lease fence. It starts at zero and increases on acquire,
handoff, and takeover. Sources: `src/protocol/events.ts:124`, `src/protocol/reducer.ts:77`.
Reusing it for planning is an explicit semantic extension, selected by `completion_policy`:

| Policy | Proposed epoch contract |
|---|---|
| `governed` | Keep the existing lease fence and its acquire, handoff, and takeover increments. Zero means no lease has been acquired. Planning assignment events cannot alter it. |
| `planning` | Use the same field as an ownership fence. Zero means no assignment has been accepted. Acceptance and each accepted owner change strictly increase it. An offer or its withdrawal does not. Reopen retains it, bumps task version, and clears ownership. The next acceptance increases it again. |

Planning commands check policy, task version, current epoch, owner where required, and task cursor.
Planning tasks reject lease, submission, and governed close commands. Governed tasks reject
planning start, completion, and drop commands. A notice or receipt advances neither epoch.
This changes the field's meaning for planning only. It needs schema and reducer coverage;
it is **not verified**. Old histories retain governed semantics through the default policy.
Task edits must not mint credentials or enlarge any grant.

## States, ownership, and completion

The roadmap asks for Open, Doing, Done, and Dropped.
Source: `/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:96`.
Use these as the planning vocabulary. Retain review detail for governed work.

| Display | Proposed mapping and transition |
|---|---|
| Open | Existing `open` or `reopened`. Creation has no owner. Planning acceptance sets an owner while keeping this lifecycle. Reopen clears the owner until another acceptance. Governed Open keeps `owner: null`. |
| Doing | Existing `active`. A planning owner explicitly starts work. An assignment alone leaves the task Open. A governed task becomes active through lease acquisition. |
| Review pending | Existing `awaiting_review`, only for governed tasks. Keep it visible. Do not collapse it into Done. |
| Done | Existing `done`. Planning uses a new explicit completion event. Governed work uses the existing submission and close checks. |
| Dropped | New terminal lifecycle value for planning tasks. Record that work was abandoned, not completed. Governed discard remains its existing disposition and authorization path. |

Checked-in create and reopen both clear `owner`. Lease events populate it and produce
`active` or `awaiting_review`. Sources: `src/protocol/reducer.ts:61`,
`src/protocol/reducer.ts:92`, `src/protocol/reducer.ts:126`.
Proposed `TaskAssignmentAccepted` deliberately permits Open with a non-null `owner`
only when `completion_policy` is `planning`. It keeps lease fields empty and does not
start work. The decision function, reducer, and projection must enforce that policy gate.
Governed tasks retain `open` or `reopened` with `owner: null`.

Planning completion and drop are allowed from Open or Doing. Only the accepted owner,
or an authorized human workspace owner or admin, may make those transitions.
Reopen is explicit and leaves prior completion or drop in history.
The existing role and epoch checks are foundations, not proof of this extension.
Sources: `src/protocol/commands.ts:202`, `src/protocol/commands.ts:217`.
Do not map `archive`, `pr`, or `discard` onto successful planning completion.
Existing dispositions are defined at `src/protocol/commands.ts:16`.

For planning tasks, assignment establishes responsibility without a lease or a file lock.
Keep lease fields empty. Any eligible member may still help and post a status.
For governed tasks, keep acquire, handoff, takeover, expiry, submission, and grants intact.
Assigning a governed task must not silently replace a live lease or its owner.
Record the offer first. Acceptance executes the permitted existing lease transition,
or reports the human action required. Sources: `src/protocol/commands.ts:137`,
`src/protocol/commands.ts:158`, `src/protocol/commands.ts:170`.

Self-assignment needs no invitation. Assignment to someone else is an offer until accepted.
A person's agent may accept under that person's explicit, bounded task grant.
Otherwise the recipient decides. Reject foreign, revoked, or ineligible identities.
An agent seat's owning person is already represented at `src/protocol/workspace-events.ts:95`.
The consent requirement follows `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:349`.
The roadmap says assigning a task wakes the agent, at
`/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:96`.
This proposal narrows that rule: offering assignment queues a notice through the existing
wake path; ownership changes only through a separate acceptance command.
Wake remains subject to the recipient's measured receive mode.
Reassignment cancels the old offer and advances the accepted ownership epoch when it succeeds.

Assignment notices use a closed, bounded schema: notice kind, workspace ID, stream ID,
task ID, offer event ID, current epoch, signal ID, and server enqueue time.
Validate identifiers and the enum. Render a fixed notice asking the recipient to inspect
the offer. Include no task title, offer text, notes, links, attachments, or evidence.
Only enqueue for a recipient already permitted to read that task. The offer grants no read
permission. Hydration rechecks the grant and offer before returning any task details.
Recipient-controlled task text remains untrusted data, and notice receipt is not acceptance.
Sources for these proposed bounds: `docs/design/SWARM-CLOUD.md:89`,
`docs/design/SWARM-CLOUD.md:355`, `src/cloud/agent-channel.ts:43`,
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:349`.

## Events and views over the log

Every successful task change appends an event. Corrections append new events.
Reuse the canonical envelope, including server actor, run, command ID, stream sequence,
schema version, and server time. Sources: `src/protocol/events.ts:34`,
`docs/design/SWARM-CLOUD.md:91`.
Use the existing transactional decision and projection flow. Keep request-hash idempotency.
Sources: `supabase/functions/command/index.ts:12584`, `src/protocol/idempotency.ts:40`.

These are proposed event families, not accepted command or event names:

| Change | Proposed event and essential payload |
|---|---|
| Name, due date, or links | `TaskDetailsChanged`: task ID, prior cursor, changed typed fields. Never an arbitrary custom-field bag. |
| Offer ownership | `TaskAssignmentOffered`: task ID, candidate kind and ID, offering actor, current epoch, consent requirement. |
| Accept or withdraw offer | `TaskAssignmentAccepted` or `TaskAssignmentWithdrawn`: offer event ID, task ID, recipient, prior and resulting epoch. Governed acceptance also emits the required lease event. |
| Start ordinary work | `TaskStarted`: planning task ID, accepted owner, current epoch. |
| Finish or abandon | `TaskCompleted` or `TaskDropped`: planning task ID, owner, epoch, minimal result or reason. No claim of evidence verification. |
| Reopen | Extend `TaskReopened` for planning and dropped state. Preserve task version increase and cleared ownership. |
| Schedule, reschedule, or cancel | `TaskScheduleSet` or `TaskScheduleCancelled`: task ID, prior schedule event ID, typed timing, attendees, and their consent references. |
| Scheduled notice | `TaskReminderQueued` or `TaskReminderSkipped`: task ID, schedule event ID, recipient, signal ID if queued, reason if skipped, scheduled time, and actual server time. |

Extend the existing create event with the new task fields through schema versioning.
Old histories upcast to the governed policy without rewritten stored events.
Register each new type and route task events to the task reducer before folding them.
The current reducer refuses unknown types and noncurrent schemas.
Sources: `src/protocol/reducer.ts:40`, `src/protocol/upcasters.ts:30`.

The shared log is explicit implementation work. Add a canonical message-post event
on the same transactional stream path as task events. Keep the original signal ID.
Its payload must contain the bounded data needed to rebuild the signal projection,
including addressing, thread links, lifetime, and attachment references.
`swarm.signals` remains the message read and delivery projection for new posts.
Append the event, project the signal, and enqueue deliveries atomically.
The current direct insert and empty event response are at
`supabase/functions/command/index.ts:9304`, `supabase/functions/command/index.ts:11580`.

Use the stream classes at `docs/design/SWARM-CLOUD.md:81` through
`docs/design/SWARM-CLOUD.md:83`. Planning tasks and workspace messages use the workspace
stream in v1. Existing repo-scoped governed tasks keep their repo stream; non-repo
governed tasks remain workspace-scoped. Calendar reads schedules from each task's stream.
Assignment and reminder message events use the referenced task's stream in the same transaction.
Other new repo messages require an explicit, authorized repository reference.
Do not derive repository scope from a channel, task link, or free-text `about` value.
These are proposed routing rules. The current signal insert carries workspace identity and
`about`, without a stream field: `supabase/functions/command/index.ts:9304`.

Do not rewrite older signals or fabricate historical stream sequences.
Keep their immutable rows as legacy history, visibly identified when mixed into a timeline.
Show legacy signals as workspace history with their existing timestamp and signal ID.
Do not assign them a repo stream or infer one from `about`.
Do not emit old deliveries again during replay or migration.
Message visibility must apply to the new event read path too. A generic events endpoint
must not reveal a directed message hidden by its message view.
Human visibility starts with the directed read view at
`supabase/migrations/20260730000002_agent_signal_receive.sql:77`, extended for multiple
recipients at `supabase/migrations/20260905000010_signal_recipients.sql:423`.
Local-agent reads further filter by the authenticated principal at
`supabase/functions/read/index.ts:913`, `supabase/functions/read/index.ts:955`.
Hosted-seat reads apply their recipient filter at `supabase/functions/read/index.ts:1120`.
The proposed events endpoint must enforce each credential's corresponding visibility rule.

Task list, board, task history, and calendar read server-filtered projections.
A board move sends a task command. It never edits a row directly.
Calendar drag sends the same schedule command as task detail.
Paginated history keeps per-stream cursors. Do not claim a global sequence across streams.
The existing stream split is at `docs/design/SWARM-CLOUD.md:81`.
Views show accepted state, pending writes, conflicts, and stale reads distinctly.
Schedule projections may rebuild from history. Rebuild does not resend a reminder.

## Calendar and scheduled wake

An appointment is a planning task with a schedule. A scheduled work item is the same object.
Its calendar entry links to its task detail. Cancel Schedule removes its calendar placement
and future reminders. Drop Task also abandons the work. Keep those actions distinct.
This implements `/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:97`.

Use UTC instants with the entered IANA time zone for timed schedules.
Use local dates and an exclusive end date for all-day entries.
Show the schedule's zone when it differs from the viewer's zone.
An ambiguous or nonexistent local time needs an explicit choice before saving.
An all-day entry has no implicit midnight agent wake. Choose a wake instant explicitly.
Do not turn due dates into schedules without the user's choice.
These timing rules implement the P2 requirement at
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:352`.

An agent attendee accepts a schedule wake through its owner's grant or explicit consent.
It must have permission to read that task. Attendee status confers no task ownership.
At the scheduled instant, a durable scheduler submits an idempotent system command.
That command rechecks the current task, schedule event, attendee, grant, and recipient.
It appends the reminder event and a minimal directed signal, then uses existing deliveries.
The signal says a scheduled task is ready to inspect. It grants no tool permission.
The existing delivery notice states that boundary at `src/cloud/agent-channel.ts:45`.

The scheduler needs a validated system actor extension. It must not impersonate a human
or agent, manufacture a run, or hold a delegated full-account credential.
The existing actor requires human or agent identity at `src/protocol/events.ts:27`.
Extend message sender validation and projection for system notices in the same contract.
The scheduler's credential permits only dispatch for an already authorized schedule.
It cannot create tasks, choose new recipients, or bypass the command decision path.
Persist the due queue, retry progress, and outcomes in PostgreSQL.
Use a shared indexed queue, not a timer or idle poll for each seat.
Durable-state policy is at `AGENTS.md:39`. Scheduler implementation is **not verified**.

Deduplicate by task identity, schedule event ID, recipient, and notice purpose.
Use a persistent unique record beyond the generic command replay window.
Lock task and schedule state during dispatch. Concurrent schedulers must reuse the same signal.
Commit event, signal, delivery, and queue outcome together. A rollback sends nothing.
A restart reconciles overdue rows. Send a late notice with its original scheduled time
and actual enqueue time. Do not claim it arrived on time.

Rescheduling, cancellation, dropping, completion, attendee withdrawal, or grant revocation
invalidates unsent reminders. Recheck already queued reminders before hydration and display.
Suppress stale details without editing the immutable signal. Keep the cancellation visible.
Reopening a completed task requires a fresh schedule confirmation before another reminder.
This protects the proposed withdrawal rules at
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:261`.
If enqueue wins a race before cancellation, history records that fact.
Cancellation cannot retract a notice already read.

Delivery rows trigger the existing content-free wake; the receiver then claims its inbox.
Sources: `supabase/migrations/20260906000010_wake_delivery.sql:169`,
`src/cloud/agent-channel.ts:511`.
The optional local listener wakes its own session and starts no model.
Agents must not use it for repository coordination. Source: `AGENTS.md:43`.
Hosts without hooks can use an already supported, approved native receiver.
Calendar supplies a timed arrival. It does not create a new host wake capability.

The supported wake-provider registry and turn behavior are at
`src/cloud/agent-onboarding-contract.ts:5`, `src/cloud/agent-onboarding-contract.ts:8`,
`src/cloud/agent-onboarding-contract.ts:12`.
Hosted seats are constrained to turn-only in `src/protocol/workspace-reducer.ts:441`.
Keep the vendor-specific limits and proof requirements from
`docs/design/2026-10-01-AGENT-ONBOARDING-MATRIX.md:205`.
Fresh vendor wake and receipt behavior are **not verified** in this lane.

| Measured condition | Proposed calendar copy |
|---|---|
| Accepted schedule, before dispatch | "Scheduled for [time and zone]. [Agent] receives reminders through [measured receive mode]." |
| Delivery queued, no receipt | "Reminder queued at [time]. Receipt is pending." |
| Turn-only recipient | "Reminder queued. [Agent] reads it on its next turn." |
| No current receiver evidence | "Reminder queued. Wake is not verified. Open [agent] or check messages." |
| Confirmed session receipt | "[Agent] received the reminder at [time]. Work has not been marked done." |
| Recipient lost access | "Reminder was not sent. [Agent] no longer has access. Choose an eligible recipient." |
| Scheduler cannot confirm enqueue | "Reminder is pending. Dispatch has not been confirmed." |

Receipt must come from the delivery record and host proof, not an agent's narrative.
The current channel records observed delivery after receipt confirmation at
`src/cloud/agent-channel.ts:437`.
Show push only while subscribed, as required by `AGENTS.md:41`.
No latency guarantee or background attendance claim follows from saving a schedule.

## Privacy and grants

Use P2's separate personal, household, and business workspaces.
A shared task or calendar reveals only deliberately shared details.
Marriage and shared billing confer no private-space access under P2's proposed rules.
Source: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:63`.
Channels provide addressing, not read permission. Source: `src/cloud/command-client.ts:170`.
Task assignment must not confer private-space access either. P2 requires permitted readers
and forbids private details in shared reminders at
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:349`.
Current workspace membership remains broad apart from directed-message filtering.
There is no existing per-task privacy boundary. Source: `SECURITY.md:43`.

Before selected-record sharing, implement P2 content grants for the named recipient,
workspace, task or selected records, allowed operations, history inclusion, expiry, and revoke.
Task read, modification, assignment, completion, schedule changes, and export need explicit
registry entries. These are proposed operations, not current accepted scopes.
Use the same registry for permission checks, consent, tool schemas, and help.
Source: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:222`.

Separate calendar detail from availability disclosure. A permitted busy interval exposes
no private title, task ID, owner, links, or appointment notes.
Availability sharing does not let an agent inspect or complete the private task.
Until those grants exist, keep private calendars in separate workspaces.
Source for the separate-workspace boundary:
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:36`.
No automatic cross-workspace availability aggregation ships in v1.
These availability limits narrow the proposed requirements at
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:352`.

Filter lists, boards, calendar ranges, history, search, counts, errors, link previews,
reminders, exports, and raw events before returning data.
Recheck links when read. A shared task cannot disclose a private wiki title through a link.
An outside agent defaults to selected, time-limited, read-only access.
Read permission grants no assignment, completion, scheduling, or bulk export permission.
Sources: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:236`,
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:243`.

Administration and content grants remain separate. A full-account choice does not silently
add task operations or another person's spaces. Provisioning can disclose content under
current membership, so do not describe admin access as content isolation.
Sources: `docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:131`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:141`.
The supplied designs disagree on future-workspace enrollment, child-access revocation,
and confirmation for routine invitations and credential issuance.
Lane A includes future owned workspaces and dependent worker revocation, while P2 excludes
future workspaces and P1 does not promise automatic worker disconnection.
Lane A allows bounded routine provisioning and member invitations. P2 requires a human
confirmation for each issuance and invitation.
Sources: `docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:78`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:136`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:215`,
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:219`,
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:124`,
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:141`,
`docs/design/2026-10-01-AGENT-ONBOARDING-MATRIX.md:260`.
Those conflicts block delegated task and calendar grants. HezLead must reconcile the
contracts before either ships, including the grants used for assignment and reminder dispatch.
This spec assumes no inferred content access and rechecks the final durable grant at dispatch.

Audit task access and changes within the owner's boundary. Do not publish private audit
into a shared household feed. Revocation stops later reads, queued disclosure, and export.
Already delivered content cannot be recalled. Source:
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:259`.
Keep sensitive details out of immutable task and reminder text.
Never store credentials, full card or account numbers, or government IDs there.
Retain minimal provenance and define deletion, retention, and export before sensitive use.
Sources: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:277`,
`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:311`.
Complete grant coverage and sensitive-data lifecycle are **not verified**.

## Signals remain advisory

A signal never claims, blocks, or closes a task. Source: `AGENTS.md:16`.
An ask, assignment notice, reminder, status, or reply may reference a task.
Posting or acknowledging it never acquires ownership or changes task state.
"I am working on this" remains a status from its author, even when another member owns it.
Only a separate authenticated task command changes the task projection.
Display accepted ownership and observed status together, with their actors and times.
This follows `/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:96`.

Scheduling reserves no exclusive time, machine, file, or agent capacity.
Overlapping schedules may be shown as warnings. They do not refuse another member's work.
Existing leases govern task submission and close, not file editing.
Source: `docs/design/SWARM-CLOUD.md:97`.
Incoming task text remains data. A calendar event cannot authorize a deployment,
credential change, money movement, or a tool-enabled action beyond the recipient's grant.
Source: `docs/design/SWARM-CLOUD.md:355`.

## What is outside v1

The roadmap excludes sub-tasks, custom fields, automations, a permissions matrix,
an integrations page, and settings pages for the five nouns.
Source: `/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:99`.
Built-in assignment and schedule notices are the specified core behavior, not a configurable
automation engine. Consent and revoke controls use the shared grant surfaces.

Defer recurrence, arbitrary reminder offsets, task dependencies, a separate project object,
external calendar sync, calendar subscriptions, and automatic availability aggregation.
Recurring events need later rules for exceptions, time-zone changes, cancellation, and grants.
P2 names recurrence and adapters as requirements to design, not verified implementations.
Source: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:352`.
The roadmap leaves project grouping open at
`/Users/yulanbot/work/cswarm-vision/ctx-commonswarm-roadmap.md:112`.

Do not host agent runtimes or start models to satisfy scheduled work.
Do not advertise wake on an offline host or a turn-only connector.
Sources: `docs/design/SWARM-CLOUD.md:75`, `AGENTS.md:43`.
No accounting engine, bank integration, money movement, or financial advice enters this scope.
Source: `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:212`.

## Phased build lanes

These are proposed scope sizes, not duration or staffing measurements.
Small means a bounded adapter or screen. Medium means a reviewed core or backend slice.
Keep at most two implementation lanes active, following the memo at
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:211`.
HezLead arranges independent review. This documentation lane runs no checks or services.

| Phase | Lane and size | Dependency and bounded output | Future exit evidence |
|---|---|---|---|
| Contract | Task reconciliation, medium | Amend the canonical task contract. Pin completion policy, owner consent, lifecycle mapping, policy-specific epoch semantics, stream routing, system actor, and schemas. Reconcile Lane A, P1, and P2 grant conflicts. | Reviewed mapping preserves old governed histories and specifies planning completion without fake evidence. |
| Foundation | Task core, medium | After contract. Extend the existing decision function, reducer, schema upcasters, and projection. Include task grants and cursor conflicts. | Replay old and new histories to the same task IDs. Planning acceptance can leave Open with an owner and no lease. Governed Open remains ownerless. Refuse stale owners, versions, and epochs. Refuse commands from the other policy. |
| Foundation | Shared log, medium | After contract. Put new message posts and task changes through one canonical stream transaction. Preserve legacy signal IDs, visibility, and delivery deduplication. Can run beside Task core. | Retry and rollback produce no duplicate event or delivery. Replay rebuilds state without sending. Directed bodies stay hidden from unauthorized event readers. |
| Tasks | Task access and clients, medium | After both foundation lanes and P2 content-grant enforcement. Add bounded task operations to human, local, and hosted adapters through one registry. | Authorized positive controls alongside foreign-workspace, revoked, expired, read-only, and hidden-link probes. Verify history and export boundaries too. |
| Tasks | Tasks screen, small | After task clients. List, board, task detail, due dates, links, owner offers, history, and pending/conflict results. | Synthetic person and agent tasks complete the full flow. Status messages leave task ownership and state unchanged. |
| Calendar | Schedule core and dispatch, medium | After tasks. Extend the same task with schedule commands, consent, persistent due queue, reminder deduplication, cancellation checks, and existing wake delivery. | Race schedulers with cancel, reschedule, complete, and revoke. Restart after commit and after rollback. Lost push retains delivery truth. Turn-only and unavailable hosts remain honestly pending. |
| Calendar | Calendar screen, small | After schedule contract; may run beside dispatch once its API is pinned. Range view and task detail share one identity and schedule command. | Same task and history in both screens. Verify time zones, all-day dates, invalid local times, permission filtering, and measured reminder status. |
| Release input | Integration evidence, small | After all feature lanes. Use synthetic records and named host artifacts. HezLead reviews release inputs separately. | Prove accepted schedule to existing-session receipt, then explicit task completion. Receipt alone cannot mean Done. Record unsupported hosts and unmeasured latency. |

Scheduler cadence, reminder lifetime, batch limits, and capacity remain **not verified**.
Implementation must pin those values in shared policy constants before exposure.
No invented timing target, launch date, production completion, or HM37 release claim follows.
