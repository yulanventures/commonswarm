# Household hub v1

2026-10-03. P7 proposal for HezLead. Documentation only.

V1 lets people and their personal agents coordinate and edit durable household
objects through hosted MCP. Each person keeps their own account and agents.

Source baseline: `c4d23b0a280cb0eec928906a4e729d27d2cdae6c`, both this
checkout's HEAD and local `origin/main`. **Measured** means source inspection here,
unless explicitly attributed to another report. Live enforcement is **not verified**.
Vendor pages were fetched today. No tests or product-service probes ran. C3PO's
inputs are reports, not proof. `docs/design/SWARM-CLOUD.md` remains canonical.

## 1. Durable shared objects over MCP

**Measured:** hosted MCP has exactly eight tools: `claim_seat`, `whoami`, `check`,
`ask`, `note`, `reply`, `working_on`, and `members`
(`supabase/functions/mcp/tools.ts:29`). Its content writes are append-only signals,
not editable objects (`supabase/functions/mcp/index.ts:221`). `check` changes batch
and ACK state; it is not read-only (`supabase/functions/mcp/tools.ts:45`).
Hosted command/read allowlists contain no file or wiki operation
(`supabase/functions/_shared/hosted-seat-auth.ts:5`).

Files and brain pages exist through the backend, CLI, and local stdio MCP's
`file_put` and `brain_put` (`src/mcp/tools.ts:38`). “CLI only” is too narrow.
Brain topics map to files (`src/cloud/brain.ts:66`). Create, commit, and retrieval
use the existing private Storage bucket and version rows
(`supabase/functions/command/file-artifacts.ts:21`, `:37`, `:103`).

**Proposed v1 types:** lists, docs, and files. A list holds stable item IDs, text,
order, and checked state. A doc holds wiki Markdown as untrusted content, never
agent instructions. A file holds bytes and metadata.
Checked items record list state, not governed task completion. Records, tasks,
calendar, and integrations follow later. Tasks need a completion-policy amendment
(`docs/design/2026-10-01-TASKS-AND-CALENDAR.md:69`).

Reuse `swarm.files`, `swarm.file_versions`, stable file IDs, and storage paths.
Add typed list/doc schemas; keep brain pages readable as docs. Each committed
revision retains bytes, human/agent attribution, server time, parent, and command
reference. Full history must include readable retired versions. Today only explicit
brain versions allow retired-byte reads
(`supabase/functions/command/file-artifacts.ts:1077`). Extend that access and the
rolling window to all v1 types. Count all retained history against quota; refuse new
revisions at quota, without silently deleting history. Ordinary files currently stop
at a fixed version cap
(`src/protocol/brain-version-window.ts:14`, `:96`).

**V1 architecture choice:** integrate list, doc, and file mutations into the
deterministic reducer through the transactional command path. Migrate legacy file
mutations to that same core before enabling v1 tools. The adapter handles storage
I/O and supplies verified facts to pure decisions under the transaction's locks.
Commit events, projections, audit, and request-digest idempotency together.
Today's file handlers run beside the reducer and repeat six protections
(`supabase/functions/command/file-artifacts.ts:6`): revocation, agent classification,
audit, idempotency, tenancy, and rate limits. Preserve all six during migration.
Lane 4 must prove legacy and hosted parity; the existing beside-reducer path is
not the v1 architecture. This integration remains proposed.

**Permissions per workspace member:** all current members can read shared objects
and history. Each human confirms a reader or editor content role. Their agents
inherit that ceiling plus the connection's approved read/create/update operations.
Administration stays separate. Human owners change roles through audited commands.
Readers cannot upload or update. Enforce roles and revocation across legacy CLI,
local MCP, hosted MCP, metadata, history, and bytes.
The current file-scope exemption must be closed for this policy
(`supabase/functions/command/index.ts:10848`). New content permissions need reviewed
consent; current `mcp` scope alone does not supply granular permissions.

Keep personal and business spaces separate: workspace members share content
(`SECURITY.md:43`). Household membership or administration grants no access to
either person's personal workspace. Connect each agent separately to each approved
workspace and purpose, with separate principals, connections, and grants. Never
reuse private-worker credentials or context in a shared worker
(`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:60`, `:86`).
Show the audience and retained history before joining. Share private material only
as an explicitly approved redacted copy. Seat resolution uses grant and handle,
without chat identity (`supabase/functions/_shared/hosted-seat-auth.ts:125`, `:132`).
Seat names cannot isolate chats sharing a grant. Where chat isolation matters,
require separate connector accounts and grants; if the vendor cannot supply that
boundary, exclude private workspaces from that connection
(`docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md:94`, `:103`).
Lane 4 enforces workspace/grant boundaries on every content route. Lane 7 must
pair authorized household access with refused cross-person access, including
metadata, history, and bytes. These are proposed gates, not measured isolation.

**Conflicts:** reads return an opaque revision bound to object and workspace.
Updates require that revision and a patch against its base. Refuse stale writes
at reservation and commit. Return conflict and the authorized current revision.
Retain the losing draft in protected, quota-counted durable storage. Show a
base/current/proposed merge preview; require reviewed retry. No blind replacement
or unbounded loop. Extend the canonical concurrency contract to these object types
(`docs/design/SWARM-CLOUD.md:286`). Today's optional integer `if_version` already
checks both boundaries but is a narrower safeguard
(`supabase/functions/command/file-artifacts.ts:635`, `:861`;
`src/protocol/brain-version-window.ts:28`). Retries with the same request and digest
recover one recorded result. A changed patch uses a new request ID.

**Proposed hosted tools:** every call uses an authenticated seat. Reads select an
object/version in that seat's workspace. Writes also require `request_id`.
Annotations below are `(readOnlyHint, destructiveHint, idempotentHint,
openWorldHint)`. They describe behavior and do not grant permission.

| Tool | Contract | Annotations |
|---|---|---|
| `object_list` | Bounded authorized IDs, types, titles, revisions, cursor. | `true, false, true, false` |
| `object_read` | Current or exact list/doc revision; bounded content. | `true, false, true, false` |
| `object_history` | Actual committed revisions with attribution and pagination. | `true, false, true, false` |
| `object_create` | Create a list/doc and its initial committed revision. | `false, false, true, false` |
| `object_update` | Version-checked list/doc patch; return commit or conflict. | `false, false, true, false` |
| `file_read` | Authorized metadata and bounded bytes through a protected transfer. | `true, false, true, false` |
| `file_upload_begin` | Reserve a new file or replacement against its base; return pending. | `false, false, true, false` |
| `file_upload_commit` | Verify uploaded bytes, recheck rights/base, commit revision. | `false, false, true, false` |

Generate schemas, consent, help, and enforcement from one reviewed registry.
Uploads use protected host attachments/streams, not local paths or arbitrary URL
fetches. Keep transfer credentials outside model text; recheck rights on byte access.
Verify size and digest before commit. Current SHA-256 is client attestation
(`supabase/functions/command/file-artifacts.ts:1020`). Return pending, committed,
conflict, refused, or unknown truthfully. Signals may cite objects; they never claim,
block, or close tasks (`AGENTS.md:16`).

## 2. A second human joins

**Measured `/app` foundation:** an Owner/Admin creates a private invite link and
copies it for delivery (`site/src/components/app/LiveDashboard.astro:7948`).
The recipient signs in and calls `accept_invitation`
(`site/src/lib/commonswarm.ts:596`, `:644`;
`site/src/components/invite/InviteOnramp.astro:208`). Email delivery is not supplied
by creating this link (`supabase/functions/command/index.ts:869`).
**Join acceptance gate is NOT PASSED:** source inspection proves the creation and
acceptance paths exist, not an end-to-end join. Both paths below require recorded
proof before v1 acceptance. This documentation-only assignment forbids tests and
product-service probes (`/Users/yulanbot/work/cswarm-vision/lanes/task-p7.md:11`),
so acceptance remains **not verified** here.

**Measured B/C/D:** B persists grants under account locks
(`supabase/functions/command/admin-delegation.ts:218`). C persists recipient-bound
invitations as `awaiting_authorization`
(`src/protocol/admin-routine.ts:713`;
`supabase/functions/command/admin-routine.ts:412`). D exposes human grant/history
reads/revoke (`supabase/functions/read/index.ts:498`;
`site/src/lib/admin-delegations.ts:29`). C's prepared own-agent attempts create no
usable connection (`src/protocol/admin-routine.ts:511`).

C1 owns OAuth admin issuance. The current provider rejects the admin resource
(`services/mcp-auth/src/provider.js:110`). Inviting needs a separate consented admin
connection, not ordinary MCP. It calls C's `admin_invite_member`; B must accept as B.
Today B must already have an account and be named in the grant's recipient allowlist
(`src/protocol/admin-routine.ts:640`).
Protected delivery, recipient redemption, and runtime proof remain unfinished.
Hosted provisioning still refuses
`hosted_runtime_authorization_required` (`src/protocol/admin-routine.ts:803`).
Follow the existing enrollment specification, not a parallel invitation system
(`docs/design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md:151`).

**Required join done-test, unrun:** lane 7 owns end-to-end evidence after lanes
4–6. The agent path cannot pass until C1 and recipient redemption are implemented
(`docs/design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md:151`).
Use separate synthetic personal and household workspaces for both paths.
(1) A creates and privately delivers an `/app` link; B signs in as B.
(2) B reviews audience/history and accepts. Reconcile one consumed invite and one
membership. Both read the shared object; B cannot read A's personal space.
(3) Retry without extra membership. Pair expired, revoked, and wrong-recipient
refusals with valid acceptance. (4) After C1/redemption, repeat from A's authorized
admin agent through protected delivery and B's independent consent. Revoke before
redemption and prove refusal. (5) B connects B's own agents. Retain safe IDs,
artifacts, state, and outcomes; a pending receipt fails. Shared ownership requires
each human's explicit choice under the collaborator policy
(`docs/design/SWARM-CLOUD.md:237`); a routine member invitation cannot make B an owner.

## 3. Connection paths by host

Use `https://mcp.commonswarm.com/mcp` for ordinary MCP. Each person authorizes their
selected household workspace. Vendor support does not prove CommonSwarm compatibility.

| Host | Path and evidence | Remaining gate |
|---|---|---|
| Meta Muse personal | **Documented by vendor:** ask Muse in chat to create a custom connector. It runs in a dedicated Meta cloud VM with protected credentials. [Connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/), [security architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse). **Proposed flow:** “Create a CommonSwarm custom connector over MCP with OAuth using https://mcp.commonswarm.com/mcp.” | Exact custom MCP/OAuth compatibility, refresh, file transfer, and CommonSwarm round trip are **NOT VERIFIED**. Measure in personal Muse, not Muse Code. No paste-URL settings screen or idle wake claim. |
| OpenAI Dot | **Documented by vendor:** ChatGPT plugin/custom MCP with OAuth is a candidate in Dot's cloud context. [Connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), [authentication](https://developers.openai.com/plugins/build/auth). | Actual Dot access, protected auth/refresh, root binding, and writes are **NOT VERIFIED**. C3PO's local child findings do not prove root connection; its adapter plan needs a verified host contract. |
| Claude | **Measured, reported:** HezLead's hosted connector regression retest 14 passed (`docs/design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md:29`). **Documented by vendor:** add a remote custom connector, authorize, and enable it in the conversation. [Claude setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). | Coordination works according to that report, not rerun here. Object tools and refresh/revoke coverage on each advertised surface need a done-test. |
| Codex | **Documented by vendor:** remote HTTP MCP in `[mcp_servers.commonswarm]` with the URL above, then `codex mcp login commonswarm`. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). **Measured, historical:** stdio identity/check/note/reply (`docs/evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt:2`). `cswarm` CLI is another local route. | Remote OAuth/object parity is **NOT VERIFIED**. Local evidence cannot prove Dot connectivity. |

On reconnect, claim a seat again and use the new grant-bound handle; do not adopt
old access by name (`docs/design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md:29`).
Hosted seats currently require turn-only status (`src/protocol/workspace-reducer.ts:441`).

**Dot Events, separately proposed:** [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
documents dots, protocol `2026-07-28`, `server/discover`, `events/list`,
`events/subscribe`, and `events/unsubscribe`. CommonSwarm currently negotiates
older versions and serves tools only (`supabase/functions/mcp/protocol.ts:15`, `:270`).
Add P5b's content-free `cswarm.signal.available` hint from committed
`swarm.signal_deliveries`, durable subscriptions/outbox/replay, verified callbacks,
and signed webhooks. Reauthorize dispatch/replay; stop on unsubscribe, expiry, or
revoke. Receipt is not execution. Actual idle-root read/response, restart, duplicates,
and withdrawal must pass P5b's done-test before changing receive status
(`docs/design/2026-10-02-OPENAI-DOT-AGENTS.md:322`). Events are not required for
the explicitly prompted demo below. Idle Dot wake remains **NOT VERIFIED**.

## 4. A generous, bounded free plan

Every v1 number below is **proposed**, retained from source policy.

| Resource | Proposed v1 allowance | Existing source |
|---|---|---|
| Humans | 25 total seats per workspace: live members plus outstanding human invitations. | `supabase/functions/command/index.ts:850`, `:8283` |
| Agents | 50 live principals per workspace, including unexpired registrars; 10 live hosted seats per connector grant across its workspaces. | `supabase/functions/command/index.ts:851`, `:5852`; `src/protocol/hosted-authority.ts:8` |
| Objects | 500 unpurged names total across lists, docs, and files. Tombstones retain their slot until purge. | `supabase/functions/command/file-artifacts.ts:54`, `:673` |
| Storage/history | 1 GiB per workspace including live/retired bytes and counted pending declarations; 25 MiB per version. Proposed rolling window: 20 live revisions, with older committed revisions retained/readable within quota. | `supabase/functions/command/file-artifacts.ts:52`, `:548`; `src/protocol/brain-version-window.ts:14` |
| Messages | 120 signals per credential per clock hour and 1,000 per workspace; retain the tighter ask sender/pair gates. Hosted bodies stay within 8,000 characters. | `supabase/functions/command/index.ts:699`, `:5535`, `:5562`; `supabase/functions/mcp/tools.ts:58` |
| Object writes | Reuse 600 validated version-create attempts per identity per clock hour and 2,000 per workspace. They bound attempts, including some refusals. | `supabase/functions/command/file-artifacts.ts:81`, `:101` |
| Workspace/invite growth | 10 live owned workspaces; 20 creations and 10 issued invitations per person per rolling day, sharing human/admin accounting. | `supabase/functions/command/index.ts:823`, `:836`, `:842`, `:8246`; `src/protocol/admin-policy.ts:11` |

Unify counters across clients. File ceilings do not ensure fairness between humans
with different numbers of agents (`supabase/functions/command/file-artifacts.ts:91`).
Read/transfer/Events limits need measured sizing before activation. CommonSwarm does
not cap vendor model bills.

**Spend breaker:** proposed retention of today's global clock-hour proxy ceilings:
100 accepted workspace creations, 400 issued invitations, 20,000 signal posts,
or 1,000 agent-token mints (`supabase/functions/command/index.ts:904`). Crossing
a ceiling latches a durable trip and security alert (`:5632`, `:5646`). It pauses
self-serve workspace creation only, with `503 signup_paused` and a retry-later
message; existing workspaces continue (`:5758`). An operator explicitly clears it.
These proxies do not meter dollars, email delivery, or file egress. Add authorized
object/transfer/event metering and tenant throttles before launch, sized from pilots.
Unauthenticated failures must not trip global shutdown. Show usage, refusals, draft,
and actual recovery path. Revoke and human recovery remain available at quota.

## 5. Minimum household demo done-test

**Demo acceptance gate is BLOCKED today.** Hosted object tools are absent, agent
invitation redemption is unfinished, and personal Muse and actual cloud Dot
round trips are **NOT VERIFIED** (sections 1–3). Vendor documentation and a local
child cannot clear these gates. Lane 7 must record exact-host connection controls
and the full object demo before v1 can pass. No step ran in this assignment.
Use synthetic data. Connect each human's personal Muse and cloud Dot, plus Tom's
Claude and Codex: four host types, with each agent belonging to its own human.

1. Record exact service/schema/client artifacts and host surfaces. Human A creates
   Household in `/app`. B joins through section 2. Both choose shared ownership and
   editor access. Personal spaces stay excluded.
2. Connect all four host types through section 3. Claim/reuse seats, verify `whoami`
   and members, and record turn-only receive. Missing Muse or actual Dot fails;
   a Mac child cannot replace either.
3. A's personal Muse creates a shared shopping list with synthetic items. Record
   the committed object ID/revision and author. B's Dot reads that exact object.
4. Claude reads and updates the same list. B's Dot deliberately submits its now
   stale patch. Require conflict, intact Claude content, and retained Dot draft.
   Dot rereads, reviews the merge, and commits with a fresh request ID.
5. Muse reads Dot's revision and makes another bounded edit. Codex reads the result
   and history. Reconcile revisions from Muse, Claude, and Dot: three editing host
   types. Reconnect and verify durable reread.
6. Send an authorized ask with the object reference, then check/reply from another
   host on an explicit turn. No signal may change the list or task ownership.
7. Lose an update response and retry its exact request. Require one revision/event.
   Pair reader-only and foreign-workspace refusals with authorized reads/writes.
   Withdraw an agent's grant and prove its later read,
   history, update, and byte requests fail; independent access still works.
8. Retain redacted command/object/event IDs, revision contents, host attribution,
   refusals, and recovery. `/app` shows result/history. All hosts and both join paths
   must pass. An Events claim additionally requires section 3's idle-Dot test.

## 6. Ordered implementation lanes

Sizes describe scope, not elapsed time. Treat C1's issuance surfaces as reserved:
admin protocol, OAuth, shared command boundaries, migrations/proofs, and shared
site/recovery (`docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md:242`). Reserve migration
IDs with the Lead. Generate bundles during integration. HezLead assigns the
independent family check and gates.
Nothing below authorizes a release or Actions dispatch.

| Order / size | Owned files | Dependencies, C1 parallelism, acceptance |
|---|---|---|
| 1. Object contract/core, M | New `src/protocol/household-objects.ts`, `household-object-events.ts`, `household-object-policy.ts`; new focused `tests/household-objects.test.ts`. | Can run beside C1 using new files only. Gate: reviewed type/permission/history contract, deterministic replay, stale patch refusal, and preserved drafts. Test-script registration waits for integration. Canonical amendment is owned by lane 4. |
| 2. Storage/transfer module, L | New `supabase/functions/command/household-objects.ts`, `household-transfers.ts`; new object migration and matching reserve/proof files. | Depends on lane 1 contract. Can prepare beside C1 with uniquely reserved files; no shared dispatch edits or schema application. Gate: atomic quota/reservation/commit, measured digest, race refusal, full history, retry recovery, byte revocation and rollback. |
| 3. Host guides/packages, S | New `docs/integrations/household/{muse,dot,claude,codex}.md`; isolated household workflow package. | Can run beside C1. Vendor-doc work only until authorized QA. Gate: exact host route and shared-connection limits; no credentials, unsupported wake, or invented listing claims. Actual content proof waits for lane 4. |
| 4. Shared integration/permissions, L | `src/protocol/index.ts`, workspace command/event/reducer files, `brain-version-window.ts`; `supabase/functions/{mcp,command,read}/` shared entry/allowlist files, `command/file-artifacts.ts`; `services/mcp-auth/src/` content consent/binding files; generated bundles/declarations; package manifests; `docs/design/SWARM-CLOUD.md`, `SECURITY.md`. | After C1 and lanes 1–2. **Cannot run beside C1.** Single writer integrates tools/reducer, consent/content policy, legacy-route fences, history and metering. Gate: migrated command/read/MCP positive and denial controls, concurrency/idempotency, legacy parity, accurate annotations. |
| 5. Second-human agent invite, L | Existing admin enrollment/routine/authority files, `services/mcp-auth/src/` recipient bindings, dedicated invitation migration/proofs and enrollment tests. | After C1; consume lanes B/C/D and enrollment 3.2–3.4. **Cannot run beside C1 or lane 4 on shared files.** Gate: section 2 both paths, protected delivery, recipient consent, single redemption, revoke race, truthful pending status. |
| 6. Household `/app` and local parity, M | New household object components; existing `site/src/components/app/LiveDashboard.astro`, `site/src/lib/commonswarm.ts`, invite components; `src/mcp/{tools,server}.ts`, `src/cloud/brain.ts`, `src/cli.ts`. | After lane 4; invite completion depends on lane 5. **Cannot run beside C1 on shared site/CLI files.** Gate: visible objects/history, conflicts and draft recovery, editor/reader controls, consistent local and hosted rights. |
| 7. Actual host pilots/demo, M | Host-specific files under `docs/evidence/2026-10-03-household-hub/`; new isolated host acceptance harness. | After lanes 3–6 and separately authorized host QA. No C1 source overlap. Gate: section 5, including personal Muse and actual cloud Dot, both humans, three editing hosts, restart/revoke. Retain unsupported outcomes. |
| 8. Optional Dot Events, L | New event core, subscription/outbox/dispatcher modules and migration/proofs; existing `mcp/protocol.ts`, hosted authority/reducer, OAuth binding and release configuration during integration. | After C1 and ordinary Dot proof. New modules can be prepared independently; shared edits serialize after lane 4. Gate: P5b idle-root test, verified signed callback, scope isolation, replay/restart, refresh/unsubscribe/revoke, duplicates and bounded loops. Does not hold the prompted object demo. |

The deliverable is a reviewed specification. Implementation, actual host acceptance,
and separately authorized release evidence remain outstanding.
