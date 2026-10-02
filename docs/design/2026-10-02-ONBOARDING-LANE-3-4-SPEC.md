# Recipient enrollment: lanes 3 and 4

Date: 2026-10-02. Implementation specification for HezLead. This document
authorizes no production operation or vendor claim.

## Evidence and baseline

Every factual claim below carries an evidence label. **Measured** means a local
read or command in this assignment; **from code** means behavior inferred from
the pinned implementation; **not verified** includes supplied live-state reports
and future acceptance requirements. Proposed implementation decisions are labelled
**proposed** and do not describe behavior already shipped.

**Measured:** the clean checkout is `lane/onboarding-build`, and both HEAD and
`origin/main` resolve to `037beb84af141f3dfc025762b0cd7b57b98a3eaf`.
All source references in this specification refer to that baseline.

**Not verified by this worker:** HezLead's task reports hosted MCP/OAuth consumer
acceptance PASSED and C/D live at edge `037beb84`, with migrations
`20261001000001` through `20261001000005` applied. No remote service, SSH,
database, browser, or credential probe runs here. This newer report supersedes
the historical pending-acceptance/undeployed descriptions in the October 2 plan
and October 1 designs; those documents retain useful requirements, not current
deployment evidence. Lane 8 site parity and other vendor acceptance remain
not verified.

## Exact remaining gaps

| Evidence | Existing foundation and remaining work |
|---|---|
| **From code:** `src/protocol/admin-policy.ts:33`; `src/protocol/admin-routine.ts:42`; `supabase/functions/command/admin-delegation.ts:64` | The registry names preparation, redemption, progress, and cancellation, but the routine command union/parser handles none of them. Registry membership does not supply an enrollment attempt. |
| **From code:** `supabase/migrations/20261001000001_admin_delegation.sql:3`, `:71`, `:84`; `supabase/functions/command/admin-delegation.ts:208`, `:253`, `:385` | Account JSON projections, append-only account events, account locks, request-digest idempotency, and transactional persistence already exist. A secret-free pending attempt can use them without a new table. Runtime keys and single-use challenges do not exist in this foundation. |
| **From code:** `src/protocol/admin-routine.ts:574`, `:599`, `:653`; `supabase/functions/command/admin-routine.ts:412` | Recipient-bound invitations are recorded as awaiting authorization; agent invitations for another owner require human confirmation. Delivery, recipient acceptance, redemption, and signed runtime receipts are absent. Existing human invitation acceptance must not be mistaken for delegated invitation acceptance. |
| **From code:** `src/protocol/admin-routine.ts:742`; `supabase/functions/command/admin-delegation.ts:311`; `supabase/functions/command/index.ts:14266` | Local worker delivery requires a signed recipient runtime credential and a private callback. Hosted provisioning refuses with `hosted_runtime_authorization_required`. The signed admin-runtime proof is not an owner-enrolled runtime key or exact-session redemption/receipt challenge. |
| **From code:** `supabase/functions/command/admin-delegation.ts:257`, `:404`; `supabase/functions/command/index.ts:14291` | Retries return a body-free receipt, not old secrets. Private delivery failure stops the parent grant. Storage delivery remains pending and is not proof that the receiving agent read setup. Completion and safe bounded delivery recovery still need their own transitions. |
| **From code:** `services/mcp-auth/src/management-bindings.js:3`, `:19`; `services/mcp-auth/src/provider.js:91` | Production OAuth management admits existing hosted human grant commands, not a public delegated runtime enrollment route. Existing MCP consent/audience must remain separate from delegated admin consent. |
| **From code:** `supabase/functions/mcp/tools.ts:28`; `src/cloud/agent-onboarding-contract.ts:5`, `:8`, `:46` | Hosted tools remain the eight seat tools. Local bootstrap prints configuration; receive and wake registries differ. There is no common delegated enrollment receipt or measured installer for all named hosts. A seat ACK cannot attest which shared connector chat read it. |
| **From code:** `src/protocol/admin-authority.ts:323`; `supabase/migrations/20261001000002_admin_routine.sql:163` | Parent terminal events stop invitations and access ancestry is enforced. New pending attempts must also stop on parent termination and workspace withdrawal; lazy expiry must be checked on use. |

## Smallest ordered commit set

### 3.1 — Pending attempt preparation and cancellation (implement first)

**Proposed:** extend the existing `admin_prepare_connection` and
`admin_cancel_connection` command family, not a competing API or a hosted MCP
tool. Preparation takes grant/workspace IDs, intended owner ID, stable
`intended_agent_id` (UUID supplied as a target reference, never authentication),
recipient connection ID, requested name, transport, and TTL. It creates no seat,
invitation, worker credential, configuration, or runtime identity.

**Proposed:** retain attempts as an optional `connections` map in the existing
account projection. Historical projections without that key mean zero attempts:
the baseline accepts no commands/events capable of producing one. Account-only
`AdminConnectionPrepared`/`AdminConnectionCancelled` events avoid widening the
workspace-history SQL allowlist. Account lock serializes target reuse. Lifetime
attempt spend is the count of retained grant attempts, including terminal ones;
there is no refund or counter reset.

**Proposed:** the live grant, actor scopes, workspace selection/current role,
recipient allowlists, transport, and registry TTL/budget all bound preparation.
First slice supports the grantor's own target only; cross-person enrollment
returns a human-confirmation requirement. Reuse matches grant/workspace/owner/
stable target; changed name, transport, recipient connection or TTL conflicts.
Same command ID uses existing digest idempotency; a new command ID with the same
target returns the retained attempt pending, without extending its deadline.
Expired or cancelled attempts are never revived under that target reference;
a deliberate replacement requires a new target reference and authorization.
Cancellation affects only the pending attempt, has empty attempt-owned access
lists, and is repeatable. Parent revoke/suspend/expiry and workspace withdrawal
cancel matching attempts in the account reducer. Deadline checks also refuse
use before expiry has been materialized.

Files: `src/protocol/admin-authority.ts`, `src/protocol/admin-routine.ts`,
`tests/p1-cli/admin-routine.test.ts`, and generated protocol/admin declarations
and OAuth management bundle. No extra package script is needed when extending
the existing test file, already named literally in `package.json`.

Tests: exercise real decision → account reducer → replay/retry/cancel, both local
and hosted *pending* routes. Valid controls must produce one retained attempt,
zero seats/tokens/workspace events, pending audit, bounded expiry, and repeatable
cancellation. Alongside controls, reject worker/hosted actors, missing scope,
foreign owner/connection, changed target, withdrawn workspace, lost membership,
expired/revoked grant, invalid TTL, and exhausted lifetime budget. Replay on a
historical projection must work; parent termination and withdrawal must preserve
history and spend while stopping pending attempts. Prove at least one new
regression fails on the baseline for the intended missing-command reason.

**Proposed release:** no migration, no production action in this assignment.
An eventual reviewed edge release and matching Node management bundle release
are required to make this command live. Real transaction/concurrency/idempotency
proof on a disposable server workspace remains a release gate, not established
by the service-free reducer tests.

### 3.2 — Owner-enrolled runtime and single-use challenge foundation

**Proposed:** add owner-authenticated enrollment of a runtime public key,
approved executable/version/digest, host, and permitted recipient connection.
Keep private keys outside the model and admin. Persist redemption and receipt
challenges with separate phases, expiry, generation, and consumed/revoked times.
Bind owner, attempt, workspace, principal (when allocated), transport, connection,
key, host session, and request digest. An admin endpoint or model session string
cannot enroll itself. Restart needs a new challenge and explicit same-attempt
session rebind. Runtime/recipient routes carry one-attempt authority only.

Files: new `src/protocol/admin-enrollment.ts` and event/reducer types;
`supabase/functions/command/admin-enrollment.ts`; OAuth management/runtime
bindings; a new timestamped migration after `20261001000005`; generated artifacts.
Add service-free `tests/admin-enrollment.test.ts` to the literal `test` list and
explicit server test entry to an appropriate package script.

Tests: real signature verify with enrolled-key positive controls, then foreign
key/session/owner/workspace, wrong phase, expired/replayed challenge, restart,
grant withdrawal, and concurrent consumption. Database tests must apply real
migrations, prove RLS and transaction rollback, and use no hand-authored schema.
Release proofs: `deploy/release-proofs/item-onboarding/` catalog, executable
rollback, rollback-catalog; verbatim reserve rollback under
`supabase/admin-delegation-reserve/`, following item-cd. Catalog checks reconcile
objects/constraints/permissions with positive controls. No SQL proof is called
executed until an authorized real server run passes it.

**Proposed release:** migration plus coordinated edge/auth release; schema-first
compatible deployment and rollback preserving attempts/history, never reviving
revoked lineages. HezLead assigns the release separately.

### 3.3 — Recipient invitation redemption and protected delivery

**Proposed:** implement `redeem_agent_connection` against the enrolled runtime
challenge and live parent inside the command transaction. Implement recipient
acceptance/redemption of existing delegated member/agent invitations with
independent recipient consent, fixed role/seat/worker ceilings, and one-use
allocation. Hosted path waits for that recipient's own OAuth connector grant,
then binds its consented workspace and claimed seat without worker bearer output.
Do not upgrade a shared MCP connector to delegated admin or adopt a foreign seat
by display name. Local delivery uses the private runtime store callback.

**Proposed:** atomically record allocation and delivery metadata, never secret
responses in replay records/events/tool output. A lost response queries the same
attempt. Recover storage only via the authenticated bound runtime; otherwise
revoke undelivered attempt-owned access and use the existing bounded replacement
policy. Cancellation/Undo never revokes an independently reused seat. Retain
parent ancestry, horizons and lifetime spend through renewal/replacement.

Files: protocol enrollment/hosted authority; command enrollment, admin routine,
delegation and hosted boundary; OAuth consent/interactions and private runtime
bindings; existing invitation/token schema only if the 3.2 foundation cannot
represent atomic redemption (then add another migration and matching proofs).
Tests: named literal service-free enrollment and hosted auth tests; server
enrollment tests. Positive recipient allocation/delivery followed by duplicate,
changed digest, wrong recipient, foreign connector, concurrent redeem/revoke,
delivery failure, deadline, cancellation and preserved pre-existing access probes.
Reconcile durable attempt/seat/token/invitation/event counts and inspect safe
responses for credential absence.

**Proposed release:** edge + auth release; migration only for identified schema
changes. Protected adapter delivery and real recipient consent are release gates.

### 3.4 — Verified connection progress and common receipt

**Proposed:** implement `record_agent_connection_progress` using recipient-bound
proof, not an admin assertion. Persist configuration, identity, inbox/setup ACK,
and server delivery references separately. Verify receipt challenge and matching
delivery in the same transaction. State sequence is awaiting authorization →
configured/proof pending → connected/turn checks; wake remains independently
pending until exact-host idle evidence passes. A hosted seat receipt is explicitly
seat-level evidence with shared-chat identity unresolved.

**Proposed:** build one secret-free receipt contract derived from server facts:
attempt, workspace, owner, seat, transport/connection, allowed capabilities from
enforcement registries, expiry, parent dependency, configured/connected/receive
states, evidence references, next action, and revoke/Undo route. It contains no
handles that function as bearer credentials, signatures, token hashes or keys.
The receipt preserves uncertainty after interruption and distinguishes withdrawn
server access from unreachable local cleanup.

Files: protocol enrollment; command progress/delivery joins; common
`src/cloud/agent-enrollment-receipt.ts`; filtered recipient/admin read contracts;
CLI and `/app` rendering (read `site/AGENTS.md` before site work). Add named literal
receipt tests to root/site scripts and server progress tests.
Tests: valid identity/inbox/setup ACK/signature/delivery control, then ACK-only,
wrong session, missing delivery, replay, foreign seat/workspace, expired grant,
reused seat Undo, interrupted configuration and cleanup failure. Receipt output
must remain pending for each incomplete control and never claim wake from config.

**Proposed release:** edge/read/CLI/site as touched. Filtered read SQL changes
need a migration, reserve rollback, and catalog/rollback proofs. Actual connected
acceptance remains not verified until the recipient done-test passes.

### 4.1 — Host guides and measured pilots

**Proposed:** document `invite_and_connect_agent` as orchestration of the canonical
commands, not a ninth hosted tool. Use `HOSTED_TOOL_TABLE`, admin scope and receive
registries as catalog sources. Cover hosted HTTP/OAuth and local stdio separately;
unknown host capabilities remain unknown. Show workspace content exposure,
shared connector boundary, human approval, minimum choices and truthful receipt.

Files: a common enrollment guide plus named Claude/Codex/second-remote-host guide
under `docs/`, CLI help/guide source and site handoff where necessary. Public
vendor instructions require fresh primary-document verification and actual-host
acceptance; this specification copies no unverified vendor install instructions.
Tests: literal receipt/guide contract tests only for independently meaningful
generated catalogs and state claims, plus fresh actual-host positive setup,
identity/roster-first, authorized inbox/exchange, refresh and revoke controls.
Keep vendor UI, browser and credential work assigned to separately authorized QA.

**Proposed release:** documentation-only guides need no migration; changed
distributed CLI/site copy needs its release. Pilot a second remote host and one
local CLI, retaining named host/version, auth/edge/site/CLI revisions and receipt.
No vendor support, listing, wake, distribution or production completion claim
follows from preparing these commits. Lane 3.1 alone leaves lanes 3 and 4 open.
