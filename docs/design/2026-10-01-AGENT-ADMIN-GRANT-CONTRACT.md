# Agent administration grant contract

Status: proposed design for HezLead and Tom. No implementation or release is claimed.
Source review: checkout `4d6a06509f9abf1aefac8c88ec00280d025df673`.
Runtime behavior, production state, vendor compatibility, and capacity are **not verified**.
No tests were run and no services were contacted.

Tom chose both granular grants and an optional full-account grant. Granular is the default.
Workspace creation is a separate permission. Full-account delegation requires visible human consent.
This follows the lane brief and Tom's later decision, which replaces the memo's earlier either-or recommendation.
Sources: `/Users/yulanbot/work/cswarm-vision/lanes/task-a.md:3`,
`/Users/yulanbot/work/cswarm-vision/TOM-VISION-2026-10-01.md:8`,
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:54`.

Everything below is a proposed requirement unless labelled as checked-in behavior.
This document specifies the amendment needed before implementation. It does not override the canonical specification today.
The canonical specification wins on conflict. [AGENTS.md:34](../../AGENTS.md#L34).

## Checked-in boundaries

| Evidence | Current source behavior |
|---|---|
| [SWARM-CLOUD.md:125](SWARM-CLOUD.md#L125) | Ordinary agent tokens cannot create workspaces, invite members, mint other agents' tokens, or administer memberships. This rule needs an explicit exception for a new credential class. |
| [workspace-commands.ts:410](../../src/protocol/workspace-commands.ts#L410), [workspace-commands.ts:675](../../src/protocol/workspace-commands.ts#L675) | The core requires a human credential for its human-only command set. Removing that gate for ordinary workers would violate this contract. |
| [workspace-commands.ts:664](../../src/protocol/workspace-commands.ts#L664), [hosted-authority.ts:237](../../src/protocol/hosted-authority.ts#L237) | A hosted grant claims hosted seats through a separate path. A hosted seat cannot execute workspace management commands, apart from the feedback exception. |
| [hosted-seat-auth.ts:5](../../supabase/functions/_shared/hosted-seat-auth.ts#L5), [mcp/tools.ts:28](../../supabase/functions/mcp/tools.ts#L28) | Hosted tools have an explicit allowlist. It contains no admin, file, or wiki tools. |
| [workspace-commands.ts:1190](../../src/protocol/workspace-commands.ts#L1190), [workspace-commands.ts:1494](../../src/protocol/workspace-commands.ts#L1494) | Worker renewal requires the presenting worker credential. Successor scopes must be equal or narrower. |
| [workspace-commands.ts:1542](../../src/protocol/workspace-commands.ts#L1542) | `revoke_agent_token` permits a worker to revoke only its exact presenting token. |
| [command-client.ts:85](../../src/cloud/command-client.ts#L85), [workspaces.ts:83](../../src/cloud/workspaces.ts#L83) | `ConnectCommand` defines administrative command shapes. Separately, `WorkspaceAgent.transport` distinguishes local agents from hosted MCP agents. These types do not grant admin permission. |
| [command/index.ts:12412](../../supabase/functions/command/index.ts#L12412), [command/index.ts:12594](../../supabase/functions/command/index.ts#L12594), [command/index.ts:12664](../../supabase/functions/command/index.ts#L12664) | The workspace command path decides, updates projections, and records accepted or domain outcomes in audit. |
| [workspace-commands.ts:1579](../../src/protocol/workspace-commands.ts#L1579), [command/index.ts:7941](../../supabase/functions/command/index.ts#L7941) | Management, join-credential, and session handlers sit outside the workspace reducer. Renewal-grant resume emits audit without a protocol event. The delegated versions need reducer decisions and events. |
| [SECURITY.md:43](../../SECURITY.md#L43) | A workspace has no private area or per-record permission. Directed signals have a read-view exception. Admin metadata scope must not be presented as content isolation. |

The hosted brief describes one connector account shared by its chats. Seat names do not isolate those chats.
That is the supplied design boundary, not a fresh vendor measurement.
`/Users/yulanbot/work/cswarm-vision/ctx-hosted-mcp-brief.md:24`.

## Credential class and lifecycle

Introduce `delegated_admin`. It represents a named runtime connection acting under a person's durable grant.
It is neither a human session nor a workspace worker token. It has an account-level admin identity.
Its identity is not inferred from a model name, agent name, environment marker, or request body.

The runtime stores short-lived access credentials and rotating refresh credentials.
The model receives an opaque connection handle. That handle is not a bearer credential.
Credentials never enter prompts, transcripts, shell arguments, signals, events, or audit records.
Store secret material in a protected runtime credential store. Hash opaque refresh credentials at rest.
Use an authenticated runtime delivery channel for provisioning. Never return a worker credential as model-visible tool text.

Extend the OAuth machinery with separate admin consent and a distinct admin resource audience.
The exact audience URL is **not verified** and must be pinned before implementation.
Worker endpoints and hosted MCP endpoints must reject admin access credentials.
The admin endpoint must reject ordinary workers, hosted seat handles, existing MCP access credentials, and human refresh credentials.
An authenticated internal adapter may dispatch approved admin commands. It must retain `delegated_admin` identity through the core.
It must never simulate a human login or forward its bearer into GoTrue authentication.

Reuse the checked-in OAuth access lifetime of five minutes and refresh ceiling of thirty days as the initial proposed admin policy.
Those values come from [provider.js:15](../../services/mcp-auth/src/provider.js#L15).
The checked-in provider requires PKCE, rotates refresh credentials, and preserves the remaining refresh lifetime.
It advertises `mcp`, with its own resource audience, rather than admin scope.
[provider.js:94](../../services/mcp-auth/src/provider.js#L94), [provider.js:115](../../services/mcp-auth/src/provider.js#L115), [provider.js:121](../../services/mcp-auth/src/provider.js#L121), [provider.js:128](../../services/mcp-auth/src/provider.js#L128).
Reuse these lifecycle bounds, not its existing consent or audience.

Both grant modes are timeboxed in the first release. The person may choose an earlier expiry.
Grant expiry must not exceed the initial refresh deadline. Access expiry is the earlier of the access policy and grant expiry.
Refresh checks the durable grant and current rights. It preserves or narrows scope and never moves the grant deadline.
Refresh rotation is atomic. Replay revokes the entire admin credential lineage.
Expiry or suspension refuses both refresh and admin calls. Human renewal requires fresh consent and a new grant lineage.
Replacement atomically revokes the prior grant. It cannot leave the earlier permission active beside the new grant.
There is no automatic standing admin grant. Standing worker renewal remains a separate choice within its human-approved policy.

Revocation is durable and terminal. It invalidates all access and refresh descendants on subsequent calls, even before access expiry.
The server rechecks revocation inside every command transaction and before every read.
It locks the grant with the affected state. A revocation committed first prevents the competing action.
An action committed before revocation remains in history. Revocation cannot retract data already read.
Queued actions revalidate at execution time. They cannot finish using authorization captured before revocation.

Access provisioned by an admin grant must depend on that grant. Record its `parent_admin_grant_id` and show the dependency at consent.
Revocation is lineage-wide in the canonical specification. [SWARM-CLOUD.md:126](SWARM-CLOUD.md#L126).
The proposed extension must carry that ancestry through worker credentials, renewal successors, and hosted seat access.
Revoking the admin grant stops all such descendants. Expiry or suspension also refuses their remote reads, commands, and renewals.
Check the parent grant on every child call, even before child token expiry. Replacement cannot erase ancestry or clear a tombstone.
Show every child seat, invitation, and connection. Cancel pending attempts and invalidate unredeemed invitation and attempt credentials when the grant ends.
Keep historical seat records. Independently human-granted memberships and pre-existing worker lineages are not descendants merely because the admin managed them.
Continuing provisioned worker access after the grant ends requires a fresh human grant and new lineage, never detaching an existing descendant.

## Grant model and consent

Persist these grant fields in PostgreSQL:

`grant_id`, `owner_user_id`, `admin_identity_id`, `connection_id`, `client_id`, `resource`,
`mode`, `registry_version`, `scope_names`, `workspace_selector`, `workspace_ids`,
`created_workspace_policy`, `target_rules`, `worker_scope_ceiling`, `role_ceiling`,
`renewal_limits`, `issuance_limits`, `expires_at`, `refresh_deadline`, `state`,
`consent_receipt_id`, `manifest_digest`, `created_at`, `suspended_at`, `revoked_at`, `reason_code`.

The consent receipt binds the authenticated person, named connection, client, resource, mode, and exact manifest digest.
It also binds the deadlines, registry version, permitted operations, workspace selector, target rules, and limits.
The server derives actor fields. Client-declared fields are untrusted requests.

### Granular default

Start with chosen workspace IDs and no mutation scopes selected.
Select operations explicitly. Include metadata read only for the selected spaces and grant status.
Each operation intersects with the person's current rights and the target restrictions.
Losing membership or a required role removes that operation immediately.
Never cache a prior role as continuing permission.

Target rules name permitted seat IDs, the person's own seats, or seats created by this grant.
They also bound invitation recipients, roles, transports, worker scopes, and credential delivery recipients.
Another person's private agents or spaces require that person's independent consent.
Shared-space member administration requires the granting person's current workspace role and an explicit shared-space grant.
The permission to manage a member does not grant access to that member's private spaces or credentials.

`workspaces:create` is off by default and separate from the workspace list.
If selected, it creates a workspace owned by the granting person within account limits.
Consent must state which selected operations apply to those new spaces.
The command atomically records that association. Creation alone must not enable every admin operation there.
No operation is inherited by unrelated spaces added later.

`renewal_limits` names allowed worker grant kinds, maximum bearer lifetime, renewal horizon, successor budget, and permitted principal IDs.
Timeboxed worker horizons stay finite. Standing worker maintenance needs explicit human selection and preserves its existing device and pause rules.
Admin renewal cannot reset a budget, extend a horizon, widen worker scopes, or revive a revoked lineage.
An idle worker pause requires explicit human resume. No delegated admin credential may lift it.
The checked-in worker policies include timeboxed and standing renewal, device binding, and idle pause.
[SWARM-CLOUD.md:126](SWARM-CLOUD.md#L126).

### Full-account option

Full-account is a separate choice. It is never an inferred upgrade from a broad granular grant.
It selects the complete routine admin registry at the version the human confirms.
New registry entries require new consent. There is no wildcard that silently gains future operations.
Workspace creation is listed and confirmed as its own included permission.
Worker scope ceilings, issuance limits, renewal limits, and grant expiry still apply.

The workspace selector covers all existing and future workspaces owned by the granting person.
Shared workspaces owned by another person require explicit workspace selection and current role checks.
Full-account never crosses into another person's private spaces because of family, billing, or shared membership.
Its own read endpoint returns administration metadata, not message bodies, file bytes, wiki contents, or exports.
It grants no billing credentials or external service access.
Provisioning is a content-access decision: a worker can read workspace content under existing member visibility and its worker scopes.
The checked-in workspace boundary has no private area or per-record permission, apart from directed signals. [SECURITY.md:43](../../SECURITY.md#L43).
Full-account therefore permits indirect content access through provisioned workers. It must not be described as content isolation.
Consent must show the covered workspaces, approved recipients, worker scope ceiling, and resulting content exposure.
Direct content tools for the admin credential require a separate reviewed grant and endpoint policy.

Before activation, the person signs in through a trusted human session and sees:

- The named agent connection and OAuth client.
- Existing spaces covered, future owned spaces covered, and any selected shared spaces.
- Every included routine operation, including workspace creation and credential provisioning.
- Content exposure through provisioned workers and their dependency on this grant.
- Renewal and issuance limits, the expiry, and the protected actions listed below.
- A clear statement that compromise can affect every covered space.

The person must select full-account and then confirm that exact summary.
The confirmation is protected against CSRF and bound to the manifest digest and authenticated session.
It is single-use and expires. The model cannot provide it or acknowledge it for the person.
Expansion requires another human confirmation. Narrowing and revocation may take effect immediately.

While active, show a standing indicator in account settings and every covered workspace:
"[Agent] can administer this account until [expiry]. View actions or revoke."
For granular grants, show the selected workspace and operation summary instead.
Suspended, expired, and revoked grants must show their actual state.
The indicator remains visible while the agent is offline. Its text comes from the durable grant.

Revoke from account settings, connected apps, any covered workspace, and the human-authenticated CLI.
Every surface calls the same account-level revocation command.
Revocation must work without the agent, its host, or a live workspace.
Workspace owners may withdraw a delegation's access to their workspace. They cannot alter its rights elsewhere.
The granting person can revoke the entire grant even after leaving or archiving a workspace.

The proposed human-only commands are `grant_admin_delegation`, `narrow_admin_delegation`,
`revoke_admin_delegation`, and `withdraw_admin_workspace_access`.
The security system may call `suspend_admin_delegation` or `revoke_admin_delegation` with a system actor.
`expire_admin_delegation` materializes a reached deadline. It cannot extend one.
Credential rotation and replay detection enter the same account decision and event path.
These lifecycle commands are outside the delegated scope registry. An admin cannot call them to grant or restore permission.
Read-only access to its own grant health and an exact-grant surrender command remain available without workspace membership.
`surrender_admin_delegation` can only revoke the presenting admin's grant. It cannot revoke another grant.

### Actions requiring a human each time

Neither mode may transfer ownership, add or remove an owner, permanently delete a workspace or account,
create another admin grant, expand this grant, disable managed-session protection, or change human sign-in and recovery settings.
Inviting or promoting a person to workspace `admin` also requires a human each time. Routine invitations use `member`.
Lifting an idle worker renewal pause remains human-only, as required by [SWARM-CLOUD.md:126](SWARM-CLOUD.md#L126) and checked by [command/index.ts:7988](../../supabase/functions/command/index.ts#L7988).
Neither may accept an invitation or vendor authorization as another person.
Cross-person access requires that person's own specific confirmation.
Full-account consent does not count as confirmation of any of these actions.

In the first release, the human performs protected actions through a human-only path.
An admin request receives `human_confirmation_required` and a safe next step.
Where a later product supports agent-assisted execution, use a single-use human approval bound to the exact action, target, proposed change, and expiry.
Consume approval in the same transaction. It grants no continuing scope.
An admin grant cannot override another person's refusal, a last-owner rule, or a prohibited product operation.
Permanent deletion and ownership-transfer workflows are **not verified** here. This contract does not invent their implementation.

## Scope registry and command mapping

These are proposed names. They are not a list of scopes accepted by the current service.
Implement one registry for enforcement, consent, tool schemas, help, command mappings, and event coverage.
Defaults below apply to granular consent. A confirmed full-account grant selects all routine entries explicitly at its pinned registry version.
No scope gives a worker admin permission.

All new `admin_*` commands keep their delegated actor through the authenticated transaction, decision function, canonical events, and reducer projections.
Existing command names in the table are foundations, not permission to call them unchanged with an admin token.
Reads use a server-filtered read adapter. The adapter records access through an audited command transaction without changing the target state.

| Scope | Allows | New command and existing foundation | Default | Risk |
|---|---|---|---|---|
| `admin:read` | Grant health, roster administration metadata, connection state, and permitted admin audit. No content bodies. | `admin_read_metadata`; new filtered read and access-record decision. Member and agent metadata types: [workspaces.ts:30](../../src/cloud/workspaces.ts#L30), [workspaces.ts:78](../../src/cloud/workspaces.ts#L78). | On for selected spaces and own grant status. | Exposes identities and administrative history. |
| `workspaces:create` | Create for the granting person and apply the approved new-space policy. | `admin_create_workspace` from `create_workspace`, [workspace-commands.ts:679](../../src/protocol/workspace-commands.ts#L679). | Off. | Unwanted spaces and account resource use. |
| `workspaces:archive` | Archive selected spaces when the person currently has the owner role. | `admin_archive_workspace` from `archive_workspace`, [workspace-commands.ts:821](../../src/protocol/workspace-commands.ts#L821). | Off. | Interrupts collaborators. No permanent deletion. |
| `seats:create` | Create own seats and provision bounded worker access for approved recipients and transports. Replace an undelivered credential without widening permission. Never provision admin credentials. | `admin_create_seat`, `admin_provision_seat`, `admin_replace_undelivered_seat_credential`; local `create_agent_principal`, `mint_agent_token`, [workspace-commands.ts:93](../../src/protocol/workspace-commands.ts#L93), [workspace-commands.ts:144](../../src/protocol/workspace-commands.ts#L144). Hosted path requires separate recipient connector consent before `claim_hosted_seat`, [hosted-authority.ts:237](../../src/protocol/hosted-authority.ts#L237). | Off. | New readers and writers can disclose workspace data. |
| `seats:renew` | Maintain named worker seats within their already approved policy. No standing-policy upgrade or suspension bypass. | New `admin_renew_seat`. Keep worker `renew_agent_token` separate, [workspace-commands.ts:1190](../../src/protocol/workspace-commands.ts#L1190). Hosted calls use an opaque capability rather than a worker bearer, [command/index.ts:13496](../../supabase/functions/command/index.ts#L13496); hosted seats do not use worker bearer renewal. | Off. | Prolongs unwanted access within the approved bounds. |
| `seats:manage` | Set descriptive model labels, enable session protection, and recover selected own sessions. Cannot lift an idle renewal pause. | New `admin_set_seat_model`, `admin_enable_seat_management`, `admin_recover_seat_session`; foundations `set_agent_model`, `enable_agent_management`, `recover_agent_session`, [workspace-commands.ts:122](../../src/protocol/workspace-commands.ts#L122), [workspace-commands.ts:198](../../src/protocol/workspace-commands.ts#L198). Add reducer events for delegated handlers. | Off. | Interrupts a live session. Cannot disable protection or resume a worker or admin grant. |
| `seats:revoke` | Revoke allowed seats or selected worker credentials and their descendants. | `admin_revoke_seat`, `admin_revoke_seat_credential`; foundations `revoke_agent_principal`, `revoke_agent_token`, [workspace-commands.ts:997](../../src/protocol/workspace-commands.ts#L997), [workspace-commands.ts:1542](../../src/protocol/workspace-commands.ts#L1542), and `revoke_hosted_mcp_seat`, [hosted-authority.ts:53](../../src/protocol/hosted-authority.ts#L53). | Off. | Stops approved collaborators. Cannot revoke human or admin credentials. |
| `invites:create` | Invite selected recipients as `member`. Admin-role invitations require a human each time. Issue agent join credentials only for approved owners and worker ceilings. | `admin_invite_member`, `admin_issue_agent_invitation`; foundations `invite_member`, `mint_agent_join_credential`, [workspace-commands.ts:72](../../src/protocol/workspace-commands.ts#L72), [workspace-commands.ts:153](../../src/protocol/workspace-commands.ts#L153). New recipient-bound join decision. | Off. | An accepted invitation discloses workspace data. No anonymous transferable admin invitation. |
| `invites:revoke` | Withdraw allowed pending member or agent invitations. | `admin_revoke_invitation`, `admin_revoke_agent_invitation`; foundations [workspace-commands.ts:79](../../src/protocol/workspace-commands.ts#L79), [workspace-commands.ts:174](../../src/protocol/workspace-commands.ts#L174). Add reducer events for join revocation. | Off. | Interrupts onboarding. Acceptance already completed needs a separate seat or membership revoke. |
| `members:manage` | Remove allowed non-owner members or demote allowed admins to `member` under the current person's rights and role ceiling. Preserve the landing-authority gate. Promotion to `admin` requires a human each time. | `admin_remove_member`, `admin_change_member_role`; foundations `remove_member`, `change_role`, [workspace-commands.ts:907](../../src/protocol/workspace-commands.ts#L907), [workspace-commands.ts:937](../../src/protocol/workspace-commands.ts#L937). Both carry optional `landing_authority_successor_user_id` and refuse `landing_authority_unresolved` if the check fails. | Off. | Removes access or disrupts repository landing. Grant must name allowed targets and roles. |
| `onboarding:connect` | Prepare, redeem, record progress, or cancel recipient-bound connection attempts. Configuration installation needs the receiving runtime's local permission. | New `admin_prepare_connection`, `redeem_agent_connection`, `record_agent_connection_progress`, `admin_cancel_connection`; registration foundation [workspace-commands.ts:706](../../src/protocol/workspace-commands.ts#L706) and hosted claim foundation [hosted-authority.ts:237](../../src/protocol/hosted-authority.ts#L237). | Off. | Credential misdelivery or installation in the wrong runtime. Cannot authorize another person's connector. |

`seats:manage` extends the memo's registry to cover existing management and recovery operations explicitly.
It does not introduce a broad `admin:*` permission.
Provisioning requires `seats:create`. Issuing a join invitation requires `invites:create` as well.
Connection preparation cannot create a seat or mint a credential unless those scopes also permit it.
Redemption uses the recipient's one-attempt credential. Progress uses recipient-bound proof, not the admin agent's claim of success.

## Transaction and recovery requirements

The canonical specification requires server-derived identity, transactional checks, events, and projections.
[SWARM-CLOUD.md:85](SWARM-CLOUD.md#L85).
Add an account grant stream and pure grant decision/reducer for grants that exist before a workspace.
The existing event envelope requires a workspace ID. An account stream therefore needs an explicit new envelope variant.
[events.ts:34](../../src/protocol/events.ts#L34).
Do not manufacture a workspace ID or anchor revoke controls to a space that can disappear.

For each admin mutation, lock the grant, check current rights, verify targets, charge persistent limits,
decide, append events, project state, record audit and idempotency, then commit.
No direct client write, external service credential, or adapter bypass is allowed.
Apply the same bounds in the pure decision core so an adapter mistake cannot enlarge permission.
Preserve ordinary worker denylist and exact-token surrender checks.
For member removal or role change, resolve landing authority in the same transaction before the membership change.
Carry `landing_authority_successor_user_id` (nullable) through the decision and audit. Check every affected repository and any supplied successor's current eligibility.
The current core requires `landingAuthorityChangeResolved` and refuses `landing_authority_unresolved` on failure.
[workspace-commands.ts:324](../../src/protocol/workspace-commands.ts#L324), [workspace-commands.ts:921](../../src/protocol/workspace-commands.ts#L921), [workspace-commands.ts:957](../../src/protocol/workspace-commands.ts#L957).
If no authorized transfer path resolves the affected repositories, refuse the change and ask a human to transfer landing authority first.
This contract does not grant permission to transfer repository landing authority.

Budgets cover workspace creation, seats, invitations, credential issuance, and renewal successors.
Count by grant lineage, granting person, and workspace. Rotation and retries never reset them.
Exact capacity ceilings are **not verified**. Use approved policy constants shared by consent and enforcement.
Missing bounds must refuse activation or the affected operation rather than mean unlimited.

Idempotency binds the admin identity and command ID to the canonical request digest.
A retry returns the recorded outcome without another seat, invitation, charge, or event.
Credential secrets are delivered outside that replayable result. Lost delivery uses a bounded replacement command that revokes the undelivered credential.
External configuration work is a durable attempt with separate progress events.
Report awaiting authorization, configured, connected, or failed as measured. A roster row alone cannot mean connected.
The strategy memo calls for recipient identity, inbox check, and setup acknowledgment as connection evidence.
`/Users/yulanbot/work/cswarm-vision/STRATEGY-MEMO-2026-10-01.md:152`.

## Human-visible events and field lists

Use domain events for successful state transitions and an append-only admin audit record for every identifiable attempt.
The human sees system-rendered action cards from those records. Agent-authored signals cannot substitute for them.
Signals stay immutable coordination messages. [AGENTS.md:38](../../AGENTS.md#L38).
An event records server facts. Untrusted names and reason text are escaped at render time.

The workspace envelope retains `workspace_id`, `stream_id`, `seq`, `event_id`, `command_id`, `type`,
`schema_version`, `actor_user`, `actor_agent_principal`, `actor_run`, `occurred_at_server`, `payload`.
These are checked-in fields. [events.ts:34](../../src/protocol/events.ts#L34).
Add server-derived `admin_identity_id`, `grant_id`, and `grant_manifest_digest` for delegated events.
Do not pretend the admin identity is a workspace worker principal.
The proposed account envelope uses `owner_user_id` and `stream_kind=account` instead of mandatory `workspace_id`.
It retains the sequence, IDs, actor, schema, time, and payload fields above.

Each action card adds `action`, `target_kind`, `target_id`, `outcome`, `reason_code`, `next_action`,
`recovery_kind`, and `related_event_ids`. These are structured fields, not an agent's narrative.
Allowed outcomes are `accepted`, `refused`, `pending`, and `failed`.
Action cards and admin audit exclude credential secrets, token digests, file content, message bodies, and private sign-in data.

The following payload fields are required unless marked nullable. Times are server timestamps.
IDs are validated identifiers. Policy and change objects have strict schemas, not arbitrary text.
Successful state changes emit both their domain event and `AdminActionRecorded` in the same transaction.
No-ops emit only `AdminActionRecorded`. Idempotent retries return the original record without appending another.

| Action or transition | Proposed visible event | Payload fields beyond the common envelope |
|---|---|---|
| Human creates or replaces a grant after consent | `AdminDelegationGranted` | `owner_user_id`, `admin_identity_id`, `connection_id`, `client_id`, `resource`, `mode`, `registry_version`, `scope_names`, `workspace_selector`, `workspace_ids`, `created_workspace_policy`, `target_rules`, `worker_scope_ceiling`, `role_ceiling`, `renewal_limits`, `issuance_limits`, `expires_at`, `refresh_deadline`, `consent_receipt_id`, `manifest_digest`, `replaces_grant_id` (nullable). |
| Human narrows a grant | `AdminDelegationNarrowed` | `prior_manifest_digest`, `new_manifest_digest`, `removed_scopes`, `removed_workspace_ids`, `new_target_rules`, `new_limits`, `new_expires_at`, `consent_receipt_id`. No expansion accepted. |
| Human or security system revokes or suspends, or presenting admin surrenders its exact grant | `AdminDelegationRevoked`, `AdminDelegationSuspended` | `grant_id`, `reason_code`, `effective_at`, `credential_lineage_id`, `cancelled_attempt_ids`, `dependent_child_ids`. A suspended grant needs fresh human consent to resume. |
| Deadline reached | `AdminDelegationExpired` | `grant_id`, `expires_at`, `detected_at`, `credential_lineage_id`, `cancelled_attempt_ids`, `dependent_child_ids`. Expiry checks apply even before this lazy event is materialized. |
| Workspace owner withdraws local delegation access | `AdminWorkspaceAccessWithdrawn` | `grant_id`, `workspace_id`, `withdrawing_user_id`, `effective_at`, `reason_code`. No rights elsewhere change. |
| Trusted runtime receives initial admin credentials after human grant activation | `AdminCredentialIssued` | `grant_id`, `credential_lineage_id`, `connection_id`, `resource`, `generation`, `access_expires_at`, `refresh_deadline`, `delivery_state`. No credential material. |
| Refresh rotates successfully | `AdminCredentialRotated` | `grant_id`, `credential_lineage_id`, `generation`, `access_expires_at`, `refresh_deadline`. No access or refresh credential material. |
| Refresh replay detected | `AdminCredentialReplayDetected` plus `AdminDelegationRevoked` | `grant_id`, `credential_lineage_id`, `replayed_generation`, `detected_at`, `reason_code`. No replayed token value. |
| Metadata or permitted audit read | `AdminMetadataRead` | `resource_kind`, `workspace_id` (nullable), `target_filter_digest`, `projection_version`, `result_count`, `audit_record_id`. No copied result contents. |
| `admin_create_workspace` | `AdminWorkspaceCreated` | `workspace_id`, `name`, `owner_user_id`, `created_workspace_policy`, `applied_scope_names`, `created_at`. Also emit the reducer-complete workspace creation event. |
| `admin_archive_workspace` | `AdminWorkspaceArchived` | `workspace_id`, `archived_at`, `prior_state`, `recovery_kind`. Never describe archive as deletion or promise restoration without a supported path. |
| `admin_create_seat` | `AdminSeatCreated` | `workspace_id`, `principal_id`, `owner_user_id`, `name`, `model` (nullable), `transport`, `turn_only`, `created_at`, `connection_attempt_id` (nullable). |
| `admin_provision_seat` | `AdminSeatProvisioned` | `principal_id`, `credential_id` (nullable for hosted transport), `recipient_connection_id`, `worker_scope_names`, `worker_policy`, `parent_admin_grant_id`, `dependent_on_admin_grant` (always true), `credential_expires_at` (nullable), `delivery_state`. A hosted seat receives no worker bearer. |
| `admin_replace_undelivered_seat_credential` | `AdminSeatCredentialReplaced` | `principal_id`, `revoked_credential_id`, `replacement_credential_id`, `recipient_connection_id`, `parent_admin_grant_id`, `worker_scope_names`, `worker_policy_digest`, `expires_at`, `remaining_budget`, `delivery_state`. Replacement cannot reset the worker horizon or parent dependency. |
| `admin_renew_seat` | `AdminSeatRenewed` | `principal_id`, `worker_lineage_id`, `predecessor_credential_id`, `successor_credential_id`, `parent_admin_grant_id` (nullable only for independently human-granted access), `worker_scope_names`, `expires_at`, `remaining_budget`, `policy_digest`. Preserve the predecessor's ancestry. |
| `admin_set_seat_model` | `AdminSeatModelSet` | `principal_id`, `prior_model` (nullable), `model` (nullable). Model labels grant no rights. |
| `admin_enable_seat_management` | `AdminSeatManagementEnabled` | `principal_id`, `prior_management_state`, `management_state`, `effective_at`. |
| `admin_recover_seat_session` | `AdminSeatSessionRecovered` | `principal_id`, `prior_session_id` (nullable), `new_session_generation`, `invalidated_session_ids`, `reason_code`, `recovery_state`. No session proof. |
| `admin_revoke_seat`, `admin_revoke_seat_credential` | `AdminSeatRevoked`, `AdminSeatCredentialRevoked` | `principal_id`, `credential_id` (nullable for whole-seat revoke), `transport`, `affected_lineage_ids`, `revoked_at`, `reason_code`. |
| `admin_invite_member` | `AdminMemberInvited` | `invitation_id`, `workspace_id`, `recipient_ref`, `role` (must be `member`), `expires_at`, `delivery_state`. Raw invitation material is excluded. |
| `admin_issue_agent_invitation` | `AdminAgentInvitationIssued` | `invitation_id`, `workspace_id`, `intended_owner_user_id`, `recipient_connection_id`, `transport`, `seat_limit`, `worker_scope_ceiling`, `worker_policy`, `expires_at`, `delivery_state`. |
| `admin_revoke_invitation`, `admin_revoke_agent_invitation` | `AdminInvitationRevoked` | `invitation_id`, `invitation_kind`, `workspace_id`, `revoked_at`, `reason_code`. |
| Recipient accepts an invitation | `AdminInvitationRedeemed` | `invitation_id`, `invitation_kind`, `accepting_user_id`, `principal_id` (nullable), `connection_attempt_id` (nullable), `accepted_at`. Actor is the authenticated recipient. It grants no extra admin scope. |
| `admin_remove_member` | `AdminMemberRemoved` | `workspace_id`, `user_id`, `prior_role`, `revoked_at`, `reason_code`, `affected_workspace_access_refs`, `landing_authority_successor_user_id` (nullable), `affected_repo_mapping_ids`, `related_landing_event_ids`. No owner removal. Emit only after the landing-authority gate succeeds. |
| `admin_change_member_role` | `AdminMemberRoleChanged` | `workspace_id`, `user_id`, `from_role`, `to_role` (must be `member`), `role_ceiling`, `changed_at`, `landing_authority_successor_user_id` (nullable), `affected_repo_mapping_ids`, `related_landing_event_ids`. Neither role may be owner. Emit only after the landing-authority gate succeeds. |
| `admin_prepare_connection` | `AdminConnectionPrepared` | `attempt_id`, `workspace_id`, `intended_owner_user_id`, `recipient_connection_id`, `requested_name`, `transport`, `capability_set`, `worker_policy_digest`, `expires_at`, `state`. |
| `redeem_agent_connection` | `AdminConnectionRedeemed` | `attempt_id`, `recipient_connection_id`, `owner_user_id`, `principal_id`, `transport`, `redeemed_at`, `state`. One attempt cannot redeem twice into different identities. |
| `record_agent_connection_progress` | `AdminConnectionProgressed` | `attempt_id`, `prior_state`, `state`, `evidence_ref`, `verified_principal_id` (nullable), `inbox_check_ref` (nullable), `setup_ack_ref` (nullable), `reason_code` (nullable), `next_action`. Connected requires recipient evidence. |
| `admin_cancel_connection` or grant cancellation | `AdminConnectionCancelled` | `attempt_id`, `cancelled_at`, `reason_code`, `revoked_attempt_credential_ids`, `attempt_owned_seat_ids`. Leave unrelated access unchanged. |
| Any identifiable admin attempt, including refusal, protected-action request, refresh failure, no-op, or external failure | `AdminActionRecorded` | `audit_record_id`, `grant_id` (nullable only when unavailable), `admin_identity_id`, `connection_id`, `action`, `target_kind`, `target_id` (nullable), `workspace_id` (nullable), `manifest_digest` (nullable), `request_digest`, `outcome`, `reason_code` (nullable), `policy_check`, `related_event_ids`, `next_action`, `recovery_kind`. |

These proposed event names require registration and reducer coverage. They are not existing accepted event types.
The current workspace event registry is explicit. [workspace-events.ts:16](../../src/protocol/workspace-events.ts#L16).
Keep the existing reducer-complete target events as well as admin attribution. Do not substitute a summary for target state.

Grant and credential records are visible only to the granting person and authorized account recovery staff.
Workspace owners see relevant workspace actions, not the person's other grant targets or private audit records.
Recipients see only their own invitation and connection progress.
Unknown credentials go to a security audit. Do not resolve private target details to decorate a refused request.
For verified admin attempts, append refusal records without changing the target state.
A rollback must produce a failure audit with `outcome=failed` and no success event.
Human-only protected actions receive their own human actor, approval receipt if applicable, and domain audit.
No rejected admin request is itself a human approval.

## Threat model

Assets are human identities, grants, refresh lineages, worker credentials, memberships, private workspace boundaries,
connection delivery channels, audit provenance, retained content, account limits, and the person's recovery access.
Actors are the granting person, collaborators, other people's agents, an honest admin runtime,
a prompt-injected admin agent, a stolen-token holder, a compromised receiving runtime, and the service operator.
Treat model output and incoming workspace content as untrusted inputs to permission checks.

| Threat | Mitigation required by this contract | Residual risk |
|---|---|---|
| Prompt injection causes workspace creation, attacker invitation, revocation, or role promotion. | Server checks scopes, recipient and target rules, current rights, role ceilings, deadlines, and persistent budgets. Human sees system-authored audit. | The injected agent can perform harmful actions that remain inside an overly broad grant. Full-account increases that exposure. |
| Access credential theft or refresh replay. | Runtime-held secrets, short access lifetime, resource binding, rotating refresh, replay tombstone, next-call revocation. | Theft permits in-scope actions before detection. Revocation cannot undo disclosure. |
| A worker, hosted chat, or request body impersonates an admin or a person. | Separate credential class, audience, verified connection identity, pure-core checks, and no fallback to human authentication. | Compromise of the authorization service or trusted runtime defeats this boundary. |
| Cross-person or cross-workspace target substitution. | Resolve identifiers under current rights and grant targets in the transaction. Require independent recipient consent. No adoption of another person's seat by name. | Shared workspace membership still exposes shared content. Granular content privacy is separate work. |
| The agent enlarges its grant or renews itself forever. | Pinned registry, finite deadline, attenuation-only refresh, fresh human consent for replacement, no admin grant issuance scope. | A human can repeatedly approve an excessive grant. |
| Credential provisioning bypasses limits by creating many seats or joins. | Worker scope ceiling, recipient binding, grant-lineage budgets, account and workspace ceilings, atomic charging, and mandatory parent-grant checks on provisioned access. | Provisioned workers and accepted invitations can disclose data while authorized. Revocation cannot retract that data. Missing policy values must refuse issuance. |
| Role promotion gives an attacker a route to human-only operations. | Explicit recipient rules and role ceiling; owner changes refused; admin-role invitations and promotions require a human each time. | A human-confirmed administrator has their own rights after acceptance. Revoking the agent grant does not revoke that person. |
| A full-account admin disables protection or removes recovery access. | Protected actions require fresh human execution. Keep account revoke independent of workspaces and agent health. | A full-account agent can still disrupt routine administration across covered spaces. |
| Concurrent refresh, revoke, retry, or renewal creates stale access. | Transaction locks, request digest, idempotency, lineage tombstones, monotone generations, checks at execution. | Actions that committed before revoke remain valid historical actions. |
| Wrong-runtime delivery, replayed connection attempt, or false connected status. | Recipient-bound attempt, one-use redemption, trusted delivery, permission-aware installer, recipient identity and acknowledgment evidence. | A compromised recipient runtime can misuse credentials it legitimately receives. Vendor consent may still require a person. |
| Shared connector chats issue admin calls as a sibling seat. | Separate admin connection and consent; refuse existing hosted MCP credentials. Display connection-level access at consent. | Chats sharing an admin connection share its permission. Separate names cannot provide chat isolation. |
| Audit leaks private account structure or supplies executable instructions. | Account and workspace visibility filters, minimal fields, bounded schemas, inert text rendering, no credentials or content bodies. | Immutable history retains necessary metadata. Retention policy needs review before sensitive use. |
| Agent floods invitations or audit attempts to exhaust resources. | Atomic issuance limits and bounded requests; rate policy by connection, lineage, account, and workspace. Keep revoke usable under load. | Distributed invalid requests can still burden the service. Capacity is **not verified**. |

## Open questions for Tom

- Accept timeboxed admin grants using the existing OAuth lifetime bounds, or require an explicit standing admin option later? Recommend timeboxed for the first release.

Before implementation, HezLead must arrange the independent review, resolve the audience and policy constants,
and land the canonical-spec amendment with the new credential, account stream, and reducer contract.
This lane changes no HM37 code, harness, deployment file, or release plan.
