> **Status (lead, 2026-09-27):** accepted by the CSwarm Strategist. Author: Codex (Alloy consult panel). Review: Grok 4.7
> round 1 FAIL (`docs/evidence/2026-09-27-item-hm/plan-review-r1.md`), v2 folded by Codex, round 2 PASS with every
> finding FIXED (`plan-review-r2.md`). Ship target set by the lead: **2026-10-09** (the §9 table below is the author's
> padded estimate). The done-test runs by Anvil in Tom's Chrome on Tom's claude.ai account, after the Strategist gets
> Tom's OK (Strategist ruling, 2026-09-27).

# HM-LANE-PLAN.md — v2

**Date:** 2026-09-27
**Item:** HM — Hosted MCP for the Claude apps
**Owner:** CSwarmDevLead
**Inspected HEAD:** `ff293022bbb33fde5c99131dc1b661d69546e8ff`
**Package version:** `0.1.80` (`package.json:3`)
**Status:** Revised implementation plan. OAuth library acceptance and public launch remain gated.
**Lane 1:** LANDED. Production release status is not established by this repository inspection.

This document replaces v1. Repository citations refer to the inspected HEAD. Proposed files, interfaces, migrations, and behavior are requirements, not claims that they already exist. No files were changed and no tests or production probes were run during this fold.

## 1. Scope and fixed decisions

A Claude connection may reuse named seats, keyed by grant, workspace, and name, with at most ten non-revoked hosted seats across the grant. Hosted MCP serves the Claude apps. Local `cswarm mcp` remains the CLI-agent path.

A seat handle is a locator, not a credential. It is usable only with an authenticated grant that owns the seat. Chats sharing a Claude connector grant can select its seats; seat names do not provide chat isolation.

No CommonSwarm agent token, join credential, OAuth access token, refresh token, authorization code, or GoTrue session may enter a model turn.

Authority changes continue through the transactional command path: derive the actor, check tenancy and permissions, append events, update projections, and commit. These requirements are explicit in `docs/design/SWARM-CLOUD.md:85`, `docs/design/SWARM-CLOUD.md:87`, and `docs/design/SWARM-CLOUD.md:91`. Web mutations retain command parity, CSRF protection, and object authorization (`docs/design/SWARM-CLOUD.md:463`).

OAuth credential storage belongs in a separate schema. It is not CommonSwarm workspace authority.

The release dependency is:

```text
Lane 1 — already landed
Lane 4 — transport foundation LAND + RELEASE
    └── Lane 2 — hosted authority and internal authentication
          ├── Lane 3 — durable check
          ├── Lane 6 — OAuth service, after spike acceptance
          └── Lane 8 — consent and Connected apps

Lane 5 — infrastructure preparation, independently releasable dark

Lanes 1, 2, 3, 4 + accepted issuer contract
    └── Lane 7 — MCP resource server

Public activation requires lanes 5, 6, 7, 8 released and integrated proofs green.
```

Lane numbers are retained for continuity, not execution order.

## 2. Authentication and authority boundaries

### 2.1 What HEAD actually does

The public read handler requires a bearer. Non-agent bearers are admitted only for `renewal_grants` and `pending_access`, then validated with GoTrue `getUser` (`supabase/functions/read/index.ts:412`, `supabase/functions/read/index.ts:440`, `supabase/functions/read/index.ts:447`).

The public command handler distinguishes registration credentials, `swm_join_`, and `swm_agt_`; other bearers reach both GoTrue `getUser` and `getClaims`, producing `verifiedHuman` (`supabase/functions/command/index.ts:11853`, `supabase/functions/command/index.ts:11857`, `supabase/functions/command/index.ts:11886`, `supabase/functions/command/index.ts:11898`, `supabase/functions/command/index.ts:11927`).

H0 creates a bearer-bearing request and invokes the public command handler (`supabase/functions/h0/forward.ts:159`, `supabase/functions/h0/forward.ts:174`). **HM must not copy that forwarding design.**

The existing agent authentication path depends on token, run, and device rows; its revocation helper receives membership status separately (`supabase/functions/_shared/agent-auth.ts:120`, `supabase/functions/_shared/agent-auth.ts:131`). Hosted seats need their own authentication branch, not fabricated agent-token rows.

### 2.2 Separate internal entry points

Lane 2 introduces two explicit, non-HTTP interfaces, alongside the existing public handlers:

```ts
handleHostedCommand(input, capability): Promise<CommandResult>
handleHostedRead(input, capability): Promise<ReadResult>
```

These are proposed contracts. They accept parsed, bounded input and an opaque, runtime-branded capability created by the MCP authentication module. They do not accept a `Request`, headers, cookies, or bearer string.

There are two capability kinds:

| Capability | Identity | Allowed use |
|---|---|---|
| `hosted_grant` | Verified provider grant and owner | `claim_hosted_seat` only |
| `hosted_seat` | Verified grant, handle, seat, workspace, and principal | Explicit hosted read/command allowlists |

A TypeScript interface alone is insufficient. The runtime constructor is private to the trusted authentication module; HTTP input cannot construct a capability. Every internal operation also reloads the durable bindings rather than trusting identifiers carried in the capability.

The call sequence is:

1. The MCP endpoint verifies the OAuth JWT and provider-family status.
2. It resolves the durable grant and, when required, seat handle.
3. It creates the internal capability.
4. It invokes the internal command or read entry point.
5. That entry point rechecks authorization in its database transaction before executing the operation or replaying an idempotent response.

**No bearer is forwarded.** The internal interfaces have no bearer parameter and do not invoke the public authentication ladder. Hosted calls cannot reach GoTrue `getUser` or `getClaims`.

Public command requests naming `claim_hosted_seat`, `open_hosted_mcp_check_batch`, or `ack_hosted_mcp_check_batch` are rejected before the bearer ladder—even when carrying a valid human session. Public headers or body fields claiming a hosted context are rejected.

The reducer independently enforces credential-kind restrictions in both directions. Hosted-grant credentials cannot execute general commands; hosted-seat credentials cannot execute consent, revocation-management, membership, token, device, session, file, or wake commands. Adding human management commands to `HUMAN_ONLY_COMMANDS` is necessary but does not replace these restrictions. HEAD’s human-only set is at `src/protocol/workspace-commands.ts:406`; its two-way join-credential fence provides a relevant pattern at `src/protocol/workspace-commands.ts:647`.

### 2.3 Hosted command attribution

Seat operations are attributed to the hosted agent principal, with its owner recorded as ownership context. They never become human operations.

Claiming the first seat has no seat principal yet. Its credential kind is explicitly `hosted_grant`; owner attribution does not grant human permissions.

Extend the idempotency credential namespace deliberately:

- Preserve `user`, `agent`, and `join`.
- Add `hosted_grant` and `hosted_seat`.
- Use grant ID and seat principal ID respectively as server-derived identities.
- Retain workspace, stream, request-hash, and command-ID binding.
- Revalidate authorization before returning a stored response.

The live constraint already includes `join`, added by `supabase/migrations/20260916000002_agent_join_attempts.sql:118`. The original two-value constraint at `supabase/migrations/20260723000001_p1_schema.sql:368` is not the live definition. Existing response lookup checks credential namespace and route binding (`supabase/functions/command/index.ts:9888`).

### 2.4 Hosted reads

The internal read interface establishes a `swarm_read` transaction and uses a narrow, reviewed security-definer function to resolve hosted authorization. It must not grant `swarm_read` unrestricted access to hosted authority tables.

That function checks:

- Grant active and not revoked.
- Provider grant/family active.
- Seat and handle belong to that grant.
- Workspace consent active.
- Workspace not archived.
- Owner remains a live member.
- Principal and membership tombstones do not revoke access.
- Principal and seat not revoked.
- `transport = 'hosted_mcp'` and `turn_only = true`.

Only after successful resolution may the read path install owner claims needed by membership-gated views. Those claims are database visibility context, not human authentication. The query still applies the authenticated principal’s inbox narrowing.

Preserve the existing recipient containment and scalar-recipient checks (`supabase/functions/read/index.ts:877`) and inbox predicates (`supabase/functions/read/index.ts:919`). Hosted reads skip token-use, run, device, renewal, and listener operations; HEAD currently records renewal use in its token path (`supabase/functions/read/index.ts:545`).

Authorization functions have fixed search paths, explicit owners, revoked PUBLIC execution, and grants only to the required internal database roles.

### 2.5 Human management is a separate flow

The authorization service may use the signed-in human’s GoTrue session for consent and revocation-management commands. It holds that session server-side.

That session is never available to the tool dispatcher. Human management code and hosted tool code have separate entry points and credential types. A human session cannot claim a hosted seat or acknowledge its batch.

Required boundary tests include a valid hosted call with GoTrue methods instrumented to throw if called, alongside a valid human-management control proving the GoTrue instrumentation works.

## 3. Grant, consent, naming, and storage design

### 3.1 One command, one workspace stream

HEAD resolves one `body.workspace_id` and one stream (`supabase/functions/command/index.ts:3003`). Registration locks one workspace stream (`supabase/functions/command/index.ts:5858`). HM will preserve that model.

A connection has one grant record with a fixed **home workspace**, chosen from the human’s selected workspaces when beginning consent. That stream records grant creation, activation, and grant-wide revocation. Choosing a home stream does not authorize writing events into other streams.

Multi-workspace consent uses this sequence:

1. `begin_hosted_mcp_grant`, human-only, addresses the home workspace. It creates a pending grant and stores the immutable selected-workspace manifest, client ID, resource, owner, interaction reference, and manifest digest.
2. For each selected workspace, `consent_hosted_mcp_workspace` addresses that workspace alone. It revalidates membership, binds the same owner/grant/manifest, appends that workspace’s consent event, and updates only its consent projection.
3. `activate_hosted_mcp_grant` addresses the home workspace. It verifies all required consent receipts and current memberships and marks the grant active.
4. Only after activation succeeds may the authorization service issue a code.

Each command has its own stable command ID and idempotency record. No command uses the first workspace’s idempotency entry as a substitute for recording the others.

The sequence is **not a multi-workspace database transaction**. Partial success leaves a pending, unusable grant and truthful per-workspace receipts. Retrying resumes with the same command IDs. Cancellation records revocation of the pending grant; it does not erase events or claim that all earlier commands rolled back.

The authorization service stores orchestration progress in its own credential/interaction schema. This is resumable workflow bookkeeping, not authority.

### 3.2 Revocation

`revoke_hosted_mcp_grant` appends a grant-revocation event in the home stream and updates the grant’s global revocation projection atomically. That single revoked grant blocks every associated seat on its next operation; it need not rewrite every seat or workspace consent.

The grant owner must retain the ability to revoke their own connection after losing home-workspace membership or after workspace archival. Lane 2 therefore includes an explicit, narrowly scoped owner-self-revocation route:

- Human authentication remains mandatory.
- The target must be that human’s grant.
- The home stream is derived from the grant.
- The only permitted transition is irreversible reduction of that grant’s access.
- This exception does not authorize reads or other commands in a departed workspace.

`revoke_hosted_mcp_seat` addresses the seat’s workspace and atomically revokes the hosted seat, handle, and principal through events and projections. It likewise permits the owner to reduce their own access without restoring membership rights.

OAuth-family revocation and CommonSwarm grant revocation are separate durable checks. Either blocks use. Provider cleanup may be retried after a CommonSwarm revocation; resource access must already be denied.

### 3.3 Seat names and concurrent claims

The original database uniqueness constraint was `(workspace_id, name)` (`supabase/migrations/20260723000001_p1_schema.sql:181`). It was dropped by `supabase/migrations/20260906000020_agent_execution_sessions.sql:4`. Do not describe it as live or recreate it indiscriminately over existing duplicate names.

The current ordinary creation rule:

- Takes the workspace principal-ceiling lock.
- Takes advisory lock namespace `1936142698` over workspace plus exact name.
- Checks exact names across principal rows, including revoked rows.
- Allows the explicit `allow_duplicate_name` exception.

See `supabase/functions/command/index.ts:5730`, `supabase/functions/command/index.ts:8137`, and `supabase/functions/command/index.ts:8152`. The reducer mirrors the duplicate exception and exact-name comparison (`src/protocol/workspace-commands.ts:960`). H0 registration separately creates principals (`src/protocol/workspace-commands.ts:738`), so testing only ordinary creation is insufficient.

Hosted claiming must:

1. Use the shared name validation/normalization contract; do not introduce independent case folding.
2. Lock the workspace stream.
3. Acquire the existing principal-ceiling lock, then the existing workspace/name advisory lock.
4. Lock the grant row to serialize the ten-seat cap across workspaces.
5. Revalidate authorization, grant activation, and consent.
6. Return the existing live seat for the identical grant/workspace/name key.
7. Otherwise query **all principal rows in that workspace** for the exact name, without an owner, transport, or active-only filter.
8. Reject any collision. Existing duplicates, including another principal alongside an existing hosted seat, fail closed.
9. Enforce both the existing workspace principal ceiling and the ten-live-hosted-seat grant cap.
10. Append events and create the principal, hosted seat, and handle in the same transaction.

Thus every live principal name is covered, and ordinary creation’s stricter treatment of historical names is preserved for hosted claims.

All principal-creation paths must participate in the same locking discipline. Ordinary `allow_duplicate_name` creation and H0 registration must refuse names reserved by a hosted seat; otherwise a local creation immediately after the hosted claim could recreate ambiguity. Existing local duplicate behavior remains available for names that are not reserved by hosted seats.

Do not acquire another workspace stream while holding the grant lock. Review the complete lock graph, including registration and revocation paths.

Required error:

```text
code: hosted_seat_name_taken
message: That name is taken in this workspace; choose another.
```

Required races: hosted/hosted under one grant, hosted/hosted under different grants, hosted/ordinary creation, hosted/duplicate-enabled creation, and hosted/H0 registration.

### 3.4 Authority schema

Lane 2 adds command-owned tables in `swarm`:

| Table | Required relationships and constraints |
|---|---|
| `hosted_mcp_grants` | Owner, unique provider-grant reference, home workspace, immutable client/resource/manifest, pending/active/revoked state |
| `hosted_mcp_grant_workspaces` | Composite grant/workspace key, consent receipt and manifest binding, revocation state |
| `hosted_mcp_seats` | Grant/workspace consent FK, unique principal, stable grant/workspace/name key |
| `hosted_mcp_seat_handles` | Seat/grant binding, one live handle per seat |

Use composite constraints to prevent a seat, principal, consent, or handle from belonging to different workspaces or grants.

Authority timestamps come from the command’s server-time/reducer input. Do not use `clock_timestamp()` defaults for event-derived projection values. HEAD obtains reducer time from `statement_timestamp()` (`supabase/functions/command/index.ts:5862`) and emits principal creation time from `ctx.now` (`src/protocol/workspace-commands.ts:973`).

Tables are owned by the administration role, with RLS and explicit command-role policies. `swarm_command` receives only required DML privileges. PUBLIC, `anon`, `authenticated`, and `swarm_read` receive no direct authority-table access.

Owner-scoped `swarm_read.hosted_mcp_connections` and `swarm_read.hosted_mcp_seats` expose management metadata, never credential artifacts. Their visibility must support owner self-revocation while withholding workspace content after membership loss.

### 3.5 Separate OAuth schema and least-privilege role

Use:

- Schema: `commonswarm_oauth`.
- Runtime login role: `commonswarm_oauth_runtime`.
- Schema/table owner: an existing privileged migration owner, not the runtime login.
- Runtime role: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
- Search path: `commonswarm_oauth, pg_catalog`.

The schema contains provider sessions, interactions, codes, refresh families, adapter artifacts, validated CIMD cache, and consent-orchestration bookkeeping. It contains no workspace authority projections.

Explicit privileges:

- Database `CONNECT`.
- Schema `USAGE` on `commonswarm_oauth`; no schema `CREATE`.
- Enumerated `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on credential tables required by the adapter.
- Sequence privileges only if the selected implementation actually uses sequences.
- RLS policies matching those operations.
- No role membership in `swarm_command`, `swarm_read`, or an administrative role.
- No direct privileges or `USAGE` on `swarm`.

If token issuance needs current CommonSwarm grant status, expose a narrow security-definer status function in `commonswarm_oauth`, with explicit EXECUTE to the runtime role. It returns only the grant/client/owner/resource binding and active status needed for issuance. Its owner may read the private authority tables; the runtime role cannot.

Conversely, resource authentication receives EXECUTE on a narrow provider-family-status function, not SELECT on OAuth artifacts. PUBLIC execution and client access are revoked. Neither status function writes authority state.

This avoids both v1 defects: a second writer inside `swarm`, and ineffective table SELECT grants without schema access or matching RLS policy. HEAD explicitly revokes public/client access to the authority schema (`supabase/migrations/20260723000001_p1_schema.sql:107`).

Anvil provisions a SCRAM credential through a protected file and configures verified TLS. The database requires SCRAM and TLS on the service network (`deploy/supabase-stack/postgres/pg_hba.conf:3`, `deploy/supabase-stack/postgres/pg_hba.conf:12`).

## 4. Implementation lanes

### 4.1 Lane 1 — Read export: LANDED

No implementation work is scheduled for lane 1.

HEAD exports `handleRequest(request)` at `supabase/functions/read/index.ts:988`. It retains OPTIONS handling, request ID, phase tracking, failure conversion, and CORS. Serving is guarded by `import.meta.main` at `supabase/functions/read/index.ts:1000`.

Its service-free source test is `tests/read-handler-main-only.test.ts:10`, included in `package.json:23`. That test checks source structure; it is not evidence of a live import or routed request.

Later lanes may refactor shared read internals for hosted authorization while preserving this public wrapper. That is lane 2 work, not a reopening of lane 1.

If lane 1 is not yet live, Anvil releases its reviewed SHA through the normal edge window. Record landed and live separately.

### 4.2 Lane 4 — Hosted transport foundation

**Size:** M
**Dependencies:** None for implementation. Must land and release before lane 2 can create hosted seats.

**Files**

- Protocol principal/event/reducer definitions.
- `supabase/functions/command/index.ts`.
- Read roster projection/types.
- New transport migration and release proofs.
- Site roster rendering and its Actions-run tests.

**Change**

Add `transport` with default `local` and `turn_only` with default `false`. Enforce allowed transports and `hosted_mcp ⇒ turn_only`.

Update event folding and the SQL principal insertion together. HEAD’s insertion lists principal, workspace, owner, name, model, creation time, and revocation only (`supabase/functions/command/index.ts:4441`). The new writer must explicitly persist event-derived transport values; hosted creation must never inherit local defaults.

This lane exposes no hosted seat-creation command. Local principals continue to receive local defaults. Managed-session and listener operations must reject hosted transport when it is later introduced.

**Views**

Start from HEAD’s complete definitions:

- `swarm_read.agent_principals`: `supabase/migrations/20260916000001_agent_join_credentials.sql:130`.
- `swarm.wake_path_eligible_deliveries`: `supabase/migrations/20260925000001_unclaimed_observed_ack.sql:75`.

Do not paste v1’s replacement SQL.

For the roster view, append the two columns without losing `model`, `managed_at`, column order, `swarm.is_member`, or registrar exclusion. There is no `p.status` column in that definition. Membership also checks workspace archival (`supabase/migrations/20260820000002_archive_revokes_access.sql:4`).

For the wake view, preserve:

- Its four-column projection.
- All lease and acknowledgement predicates.
- Release cutoff.
- Signal expiry and `ask`/`note` restriction.
- Recipient checks.
- Principal revocation check.
- Observed-ack evidence.
- Later-delivery exclusion and millisecond ordering.
- `security_barrier`, owner, and all revokes.

Add only the hosted exclusion, expressed as `p.turn_only = false`. The private source must remain revoked from `swarm_read` and `swarm_command` as well as clients (`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:118`).

**Acceptance**

Pure reducer tests; edge checks; Actions `server` tests proving an otherwise eligible local seat remains eligible while a hosted seat does not; Actions `site` tests for roster copy. Catalog tests compare complete view definitions and privileges.

**Release**

Apply the transport migration and release compatible edge/site changes immediately when green. Retain complete pre-HM view definitions in the reviewed rollback artifact. Lane 2 waits for the forward production proofs.

### 4.3 Lane 2 — Hosted authority and internal authentication

**Size:** L
**Dependencies:** Lane 4 landed and released; lane 1 landed.

Implement §§2–3, including:

- Grant lifecycle and one-command-per-workspace consent.
- Hosted credential kinds and reducer gates.
- Internal command/read entry points.
- Atomic name claiming and all competing creation paths.
- Grant, seat, handle, principal, membership, and archival checks.
- Human owner self-revocation.
- Owner management views and narrow internal read functions.
- Idempotency constraint migration preserving `join`.

**Files**

Add hosted command/event/reducer modules under `src/protocol/`, and `supabase/functions/_shared/hosted-seat-auth.ts`. Change protocol exports, existing principal creation paths, command/read internals, and named test gates. Add the authority migration and proofs.

Regenerate `supabase/functions/_shared/protocol.js` with `npm run build:command-core`; that command is defined at `package.json:19`.

**Acceptance**

Service-free reducer/auth-boundary tests plus Actions `server` coverage for:

- Every name race in §3.3.
- Cross-workspace grant-cap races.
- Stable reuse without resurrecting revoked seats.
- Both credential-kind directions.
- Hosted calls never invoking GoTrue.
- Human bearer refusal for hosted-only commands.
- Principal attribution for hosted signals.
- Revocation before idempotent replay.
- Partial consent remaining unusable.
- Activation requiring every receipt.
- Owner self-revocation after membership removal/archive.
- RLS, schema privileges, function EXECUTE, and cross-owner view denial.

**Release**

Release schema and edge changes with public hosted issuance disabled. This lane may now safely support internal hosted-seat tests because transport protection is already live.

### 4.4 Lane 3 — Durable hosted `check`

**Size:** M
**Dependencies:** Lanes 1, 2, and 4.

Local `check` uses `check.json` (`src/cloud/agent-check.ts:138`), and deferred cursor writing occurs at `src/cloud/agent-check.ts:377`. Stdio MCP retains its deferred-commit path (`src/mcp/server.ts:127`).

Hosted state lives in PostgreSQL:

- `swarm.hosted_mcp_check_cursors`.
- `swarm.hosted_mcp_check_batches`.
- Composite seat/grant/workspace consistency constraints.
- One active batch per seat.
- Bounded ordered signal IDs and terminal cursor.
- Command-only writes, RLS, and no client access.

The existing H0 partial-index pattern is at `supabase/migrations/20260922000001_h0_poll_lock_and_batch.sql:103`; HM does not inherit H0’s token or lease identity model.

Commands:

- `open_hosted_mcp_check_batch`.
- `ack_hosted_mcp_check_batch`.

Both require `hosted_seat`.

Tool contract:

```json
{
  "seat": "seat_<opaque>",
  "ack": "<optional prior batch UUID>"
}
```

**Atomic behavior**

- Serialize batch open and ACK on the seat/cursor.
- A matching ACK advances the committed cursor and closes that batch in one command transaction.
- Repeating an ACK for that same already-acknowledged batch is idempotent and cannot acknowledge a newer batch.
- A wrong-seat, wrong-grant, or unrelated batch ID is refused.
- Without ACK, return the existing active batch.
- With no active batch, select and persist the next bounded batch under the same serialization boundary, or revalidate a read candidate/version before committing it.
- Never persist an empty batch.
- Never advance beyond messages actually included in the bounded response.
- Lost responses and worker restarts leave the batch replayable.
- Replay resolves the recorded IDs through the same authorized visibility path; it must not silently return a different set because a signal expired between calls.
- Batches store IDs, not mutable copies of signal bodies.

**Cursor precision**

Use exactly:

```text
(date_trunc('milliseconds', created_at), signal_id)
```

for comparison, ordering, terminal cursor storage, ACK advancement, and wire serialization. Store timestamps already truncated to milliseconds and constrain that representation. Do not rely on a timestamp type that rounds rather than truncates.

HEAD truncates both sides of cursor comparison and orders by the same key (`supabase/functions/read/index.ts:944`, `supabase/functions/read/index.ts:959`). The TypeScript comparator uses `Date.parse` (`src/cloud/signals.ts:628`).

Test same-millisecond rows with different microseconds and reversed UUID ordering across page boundaries.

**Gates and release**

Pure ordering/replay tests; edge checks; Actions `server` concurrency, rollback injection, membership loss, and restart tests; applicable Actions `p1-cli` compatibility tests. Release migration and edge behavior as soon as green, with public MCP still gated.

### 4.5 Lane S — Existing OAuth compatibility spike

**Status:** Separate spike in progress outside this fold; result **NOT VERIFIED**.
**Capacity:** Counts as one of the two concurrent Alloy lanes while active.

`oidc-provider` 9.12.2 is the candidate from v1, not an accepted production dependency. The exact installed artifact, integrity, runtime compatibility, and relevant extension points must be recorded by the spike.

The project lists OAuth/OIDC features and experimental CIMD, but that is not proof of this deployment’s transaction or fetch integration. [Official project documentation](https://github.com/panva/node-oidc-provider).

**Required output**

- Exact dependency/version/integrity.
- Concrete source references for the extension points used.
- Executable evidence for every requirement below.
- A PASS/FAIL disposition, not “probably supported.”

**CIMD replacement gate**

The library’s own CIMD network fetch must be **replaced**, not preceded or wrapped by a separate validation request.

Acceptable integration requires a supported hook that replaces the complete transport with the CommonSwarm pinned fetch, or disabling built-in CIMD and using a supported client-resolution extension that supplies only metadata fetched by that transport.

The spike must prove:

- A CIMD cache miss causes only the controlled transport to connect.
- Refresh/revalidation and error paths cannot fall back to the built-in fetch.
- Redirects, private addresses, DNS rebinding, and oversized/slow responses never reach an uncontrolled fetch.
- The chosen pinned release supports this integration without a global-fetch monkey patch.

**No such hook is verified in this plan.** Until the spike identifies and proves it, `oidc-provider` is not approved. If the replacement cannot be made, reject that candidate and evaluate another maintained provider against the same tests. Do not compensate with a preflight fetch or hand-written OAuth endpoints.

**Refresh transaction gate**

Prove that the complete token request can run on one pinned PostgreSQL connection through lookup, validation, consumption, successor insertion, and family revocation. Details are mandatory in §5.3.

If the provider cannot preserve that boundary, it is not accepted with this adapter. Choose another maintained implementation or a supported transactional integration, then repeat the proof.

The spike may use minimal fixtures; it does not depend on unfinished CommonSwarm schema. Its contract and results feed lane 6.

### 4.6 Lane 5 — Router and box preparation

**Size:** M
**Dependencies:** None for dark infrastructure preparation; activation waits for the service and resource server.

**Files**

- `deploy/edge-runtime/main/router.ts`.
- `deploy/edge-runtime/main/index.ts`.
- Edge environment examples, bootstrap/build wiring, and verification docs.
- New `deploy/mcp-auth/` Compose/runbook/verification files.
- New reviewed Caddy site configuration.
- Configuration tests and release-procedure additions.

HEAD’s function list has five names (`deploy/edge-runtime/main/router.ts:1`). Add `mcp` when a runnable worker is included; do not release a router entry pointing at an absent module.

The worker receives an explicit environment allowlist. HEAD selects that list at `deploy/edge-runtime/main/index.ts:82`; existing maps are at `deploy/edge-runtime/main/router.ts:181`.

Allow database configuration, required existing public Supabase configuration, issuer/resource/JWKS configuration, origins, and bounded limit settings. Exclude OAuth signing keys, cookie keys, refresh material, database credentials for the OAuth runtime role, and `SUPABASE_SERVICE_ROLE_KEY`.

Existing command/read modules require Supabase URL and anon configuration at initialization (`supabase/functions/command/index.ts:1076`, `supabase/functions/read/index.ts:36`). Either retain those public configuration values or refactor initialization in lane 2. Do not claim imports work with database settings alone. Hosted operations still never invoke GoTrue.

Keep OAuth work outside the edge pool. HEAD configures 96 MiB user workers (`deploy/edge-runtime/main/index.ts:35`), four-way parallelism, and a 10,000 ms request queue timeout (`deploy/edge-runtime/compose.yaml:17`).

**Gates and release**

Pure route/environment/configuration tests; Actions `p1-cli` container tests; edge checks. Anvil releases valid infrastructure preparation as each part becomes green. Unavailable backend routes return an explicit disabled response; no route advertises working authorization prematurely.

### 4.7 Lane 6 — OAuth service

**Size:** L
**Dependencies:** Accepted lane S result, lane 2 command contract, lane 5 service layout.

**Files**

Add `services/mcp-auth/` with package/lockfile, TypeScript configuration, Dockerfile, server/provider integration, PostgreSQL adapter, CIMD transport, GoTrue integration, consent orchestration, logging, health, and tests.

Add the separate-schema migration and proofs. Add named unit and PostgreSQL gates with explicit Actions wiring.

Implement the token, transaction, storage, and deployment contracts in §§3.5, 5, and 7.

**Acceptance**

- Discovery, issuer/resource, PKCE, redirect, and code-binding tests.
- Pinned CIMD transport replacement evidence.
- Refresh race and process-crash tests on real PostgreSQL.
- No credential logging or model-visible secrets.
- Durable state across restart.
- Role/privilege positive and negative controls.
- Container UID/GID, file modes, mounts, limits, healthcheck, restart, and logging checks.
- Resource refusal after provider-family revocation.

Only service-free tests enter root `npm test`. PostgreSQL adapter tests run through Actions `server`; container checks run through Actions `p1-cli`.

**Release**

Anvil applies the migration and releases the service immediately when green, initially with public authorization disabled. Health, discovery, key loading, TLS database access, and rotation can be verified through the protected operational path.

### 4.8 Lane 7 — MCP resource server

**Size:** L
**Dependencies:** Lanes 1–4, accepted lane S issuer contract; integration requires lane 6.

**Files**

Add `supabase/functions/mcp/` with endpoint, authentication, protocol, tools, origin checks, bounded rate/concurrency control, and Deno configuration. Complete lane 5 routing and add this entry point to `check:edge`.

HEAD’s edge check names five functions plus the main router (`package.json:22`); adding a directory does not add a check.

**HTTP**

- Exact resource endpoint: `POST https://mcp.commonswarm.com/mcp`.
- Protected-resource metadata: `/.well-known/oauth-protected-resource/mcp`.
- Reject arbitrary `/mcp/*` paths.
- Default to stateless operation with explicit seat handles.
- Support only protocol revisions proven by fixtures and real-client measurement.
- If compatibility requires session identifiers, they are transport state only, never grant or seat authority.
- Validate an Origin when present against the measured allowlist.
- Requests without Origin require valid authentication before tools run.
- Bound body size, response size, parsing, request duration, and concurrency.

Unauthenticated resource requests return:

```http
WWW-Authenticate: Bearer resource_metadata="https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp"
```

The metadata names the exact resource and authorization-server URLs. This follows the protected-resource discovery mechanism in [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html).

**JWT verification**

Require ES256, known/bounded `kid` lookup, valid signature, exact issuer and audience, bounded time claims, and signed provider-grant identity. Reject token-provided key URLs and algorithm substitution.

An unknown `kid` permits one bounded JWKS refresh. Failure is closed. Every tool call additionally checks durable provider and CommonSwarm authorization state; JWKS caching never substitutes for revocation checks.

**Tools**

| Tool | Arguments | Operation |
|---|---|---|
| `claim_seat` | Workspace ID, name | Hosted-grant claim |
| `whoami` | Seat handle | Selected seat identity |
| `check` | Seat handle, optional ACK | Durable batch/read/ACK |
| `ask` | Seat, recipients, body, request ID | Bounded signal posting |
| `note` | Seat, body, optional recipients, request ID | Bounded signal posting |
| `reply` | Seat, signal ID, body, request ID | Existing reply semantics |
| `working_on` | Seat, body, request ID | Existing signal semantics |
| `members` | Seat | Workspace directory read |

Use a dedicated hosted tool table with `additionalProperties: false`. Retryable mutations require stable request IDs. Do not reuse local-only tool exposure: the local table includes `file_put` and `brain_put` with filesystem paths (`src/mcp/tools.ts:38`).

No arbitrary command/resource, file upload, brain upload, token, wake, device, managed-session, or local-profile operation is exposed.

**Limits**

Measure final values before launch. Cross-worker limits must be enforced by a shared gateway or bounded PostgreSQL mechanism; process counters are supplemental only. Any new durable operational table requires an explicit migration/proof addition. Do not hide it inside “no migration.”

Grant caps and command idempotency always remain transactional authority checks.

**Gates and release**

Pure protocol/auth/schema tests; edge checks; Actions `server` end-to-end and restart tests; applicable Actions `p1-cli` and release-bundle verification. Release the worker when green with external tool access disabled until lane 8 and integration acceptance.

### 4.9 Lane 8 — Consent page and `/app` Connected apps

**Size:** M–L
**Dependencies:** Lane 2 authority contract and lane 6 interaction contract.

This is a staffed implementation lane, not lead spare-time work.

**Files**

- `services/mcp-auth/src/interaction-page.ts` and interaction assets/templates.
- `services/mcp-auth/src/consent.ts`.
- `services/mcp-auth/src/connections.ts`.
- `site/src/lib/connected-apps.ts`.
- `site/src/components/app/LiveDashboard.astro`.
- Connected-app components and browser tests.
- Site test wiring and service interaction tests.

The site remains static Astro with vanilla browser JavaScript, consistent with `site/AGENTS.md:7`. Dynamic interaction pages are served by the OAuth service.

**Consent page**

Show the client ID host, signed-in identity, explicit workspace selection, and this warning:

> Chats using this Claude connection can use any seat created by the connection. Seat names do not isolate chats. These seats check messages during a chat turn; they do not run a listener.

Show the ten-seat cap and the revocation location. Escape untrusted client/workspace labels; do not fetch arbitrary client logos.

Selection is bound to the interaction and recorded through §3.1’s commands. Partial failures show which consent steps succeeded and that the connection remains inactive.

**Connected apps**

Show client identity, connection status, consented workspaces, hosted seats, and grant/seat revoke actions. A completed revoke means the durable deny state committed. A pending or failed operation cannot render success.

Grant revocation stops all its seats. Seat revocation affects only that seat. The owner can revoke after losing workspace membership.

Management requests use the authenticated OAuth-service browser session and the CSRF controls below. The service invokes human command APIs; it never writes authority rows directly.

**Gates and release**

Interaction security/unit tests, Actions `server` orchestration tests, and Actions `site` browser tests covering consent, partial failure, reload/retry, IDOR, grant revoke, seat revoke, and secret absence.

The Actions site gate must exercise the real interaction rendering as well as `/app`; extend its fixture/service setup as needed. Release service UI and static site when green. Public connector activation follows integrated acceptance.

## 5. OAuth and browser security contracts

### 5.1 CSRF and interaction binding

Use a server-side interaction session with a random session identifier in:

```text
__Host-cswarm-oauth
Secure; HttpOnly; Path=/; SameSite=Lax
```

Set no `Domain`. Persist session/interaction state in PostgreSQL; process memory is only a cache.

Bind each interaction to:

- Browser session.
- Exact client ID and redirect URI.
- Resource, requested scopes, and PKCE challenge.
- OAuth request state.
- A separate random CommonSwarm sign-in state.
- Authenticated GoTrue user after sign-in.
- Selected-workspace manifest and its digest.
- Expiry and completion status.

For the GoTrue round trip, persist a one-use random state and PKCE verifier before redirect. The callback must prove matching state, browser session, interaction, expiry, and code exchange before attaching the human identity. The integration test must prove how the selected GoTrue flow round-trips that state; an absent or stripped state is a blocker, not permission to omit binding.

After authentication, rotate the session identifier and invalidate pre-authentication consent tokens.

Consent rendering creates a random synchronizer token bound to that session, user, interaction, and selection version. POST requires:

- Exact allowed Origin.
- Matching session cookie.
- Matching synchronizer token.
- Live interaction and authenticated user binding.
- Valid current workspace selection.
- Atomic consumption or transition of the interaction.

Missing, stale, swapped, or replayed tokens fail closed. OAuth `state` does not replace the consent synchronizer token.

For `/app` management, allow credentialed CORS only from the exact approved CommonSwarm app origins. Fetch the session-bound synchronizer token through an authenticated endpoint and require it in a custom header for revocation. No wildcard origins, GET mutations, or browser-supplied owner IDs.

Use `Cache-Control: no-store`, restrictive CSP, `frame-ancestors 'none'`, and no third-party scripts on interaction pages. Cookies, codes, tokens, and request bodies are excluded from logs.

### 5.2 Token contract

- Issuer: `https://mcp.commonswarm.com`.
- Resource/audience: `https://mcp.commonswarm.com/mcp`.
- Authorization code: opaque, single use, 60 seconds.
- PKCE: required, S256 only.
- Access token: ES256 JWT, five minutes.
- Refresh token: [REDACTED] rotated on every successful use.
- Refresh session absolute lifetime: 30 days.
- Public client authentication: `none`.
- Token requests: form encoded.
- Resource required and bound at authorization, code exchange, and refresh.
- Refresh may narrow scope, never widen it.
- Authorization response includes issuer identification.
- Web redirects match exactly.
- Any native-loopback exception must be separately enabled, narrowly validated, and proven against the measured client; no general localhost wildcard.

Codes bind client, redirect, resource, challenge, interaction, and activated consent. Bearer-equivalent lookup values are hashed before persistence when the provider contract permits; unavoidable recoverable credential payloads require protected storage and explicit review.

Refresh replay protection and redirect/PKCE tests follow the security requirements covered by [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

### 5.3 One pinned refresh transaction

The selected integration must implement this actual boundary:

1. Before provider token processing, acquire one pool connection and `BEGIN`.
2. Attach that connection to request-local state.
3. Every adapter lookup, consume, insert, grant update, and family-revocation operation uses that connection; fallback to a fresh pool query is an error.
4. Lock the family and presented token in a consistent order.
5. Validate expiry, client, resource, scope, and grant.
6. Consume the token with compare-and-set semantics.
7. Insert the replacement and update family state.
8. Buffer the response; do not send success headers or bytes yet.
9. Commit.
10. Release the connection and send the response.

For replay, persist family revocation and **commit that denial transaction** before returning `invalid_grant`. Do not let generic error handling roll back the revocation.

Concurrent reuse produces one rotation success and one replay denial; after replay commits, the successor and existing JWTs are unusable because every resource call checks family status.

Termination before commit rolls back consumption and insertion together. Termination after commit but before response may make the client’s retry a replay that revokes the family; fail closed and require reconnection rather than silently accepting reuse.

The spike must instrument connection identity and transaction state across callbacks and test these crash points. Merely using `SELECT FOR UPDATE` inside one adapter method does not satisfy this contract.

### 5.4 CIMD transport

The replacement transport must:

- Accept HTTPS only.
- Reject redirects.
- Validate every DNS result, including IPv4-mapped IPv6.
- Reject all non-public destinations, including the Docker network.
- Pin the socket to the validated address while preserving original hostname TLS verification and SNI.
- Bound connection, headers, body time, total time, and bytes.
- Require valid JSON and exact document `client_id` equality.
- Validate all redirect URIs.
- Cache only validated metadata with bounded expiry.
- Revalidate on refresh without fallback to an uncontrolled fetch.
- Avoid logging response bodies or sensitive URL query data.

The library integration remains **NOT VERIFIED** until lane S proves complete replacement.

## 6. Verification placement

| Gate | Execution location |
|---|---|
| Focused service-free tests; root `npm test` | Approved sandbox/lead environment |
| Protocol generation, TypeScript and edge checks | Lead environment |
| PostgreSQL, migrations, adapter races, local-stack integration | Manual Actions `server` suite |
| Docker-dependent CLI/config/container tests | Manual Actions `p1-cli` suite |
| All site/browser tests | Manual Actions `site` suite |
| DNS, Cloudflare, TLS, Compose, mounted secrets, production behavior | Anvil under HezLead |
| Real Claude interoperability | Tom or Anvil |

Root `npm test` is a literal list (`package.json:23`). Add service-free tests explicitly. PostgreSQL tests never enter that list.

The manual workflow offers `server`, `p1-cli`, and `site` (`.github/workflows/server-suite.yml:30`). It builds before site testing (`.github/workflows/server-suite.yml:77`) and explicitly excludes Docker/browser execution on the mini (`.github/workflows/server-suite.yml:6`).

Do not run broad `test:p1-cli` on the mini merely because Docker-dependent files may skip. One such file invokes Docker to detect availability (`tests/p1-cli/n-db-cron-jobs.test.ts:35`). Select known service-free files locally; use Actions for the complete suite.

Extend the server workflow to install and run the OAuth PostgreSQL tests explicitly. An unreferenced service package script is not a gate.

For every denial test, include a valid positive control in the same invocation. Preserve exit codes. Record exact tested SHA and suite. Respect the workflow’s documented dispatch budget and timeout (`.github/workflows/server-suite.yml:15`); do not remove limits to make the schedule appear shorter.

Loading and packaging changes require the release bundle check and relevant CLI tests. Site tests remain in Actions even when the site change is small.

## 7. Box deployment and migration contract

Only Anvil executes box or Cloudflare changes, directed by HezLead. Release inputs must be reviewed SHAs landed on `main`; CI does not deploy (`deploy/RELEASE-TO-BOX.md:7`).

### 7.1 OAuth service shape

| Setting | Required value |
|---|---|
| Compose project | `commonswarm-oauth` |
| Operational owner | `commonswarm` |
| Immutable releases | `/home/commonswarm/oauth/releases/<sha>` |
| Active symlink | `/home/commonswarm/oauth/current` |
| Network | `commonswarm-net` |
| Host publication | Only `127.0.0.1:<confirmed-port>` |
| Allowed host port | One of `3490`–`3499` |
| Memory | `mem_limit: 512m` |
| CPU | At most `1.0` |
| Restart | `unless-stopped` |
| Health | Bounded HTTP healthcheck with interval, timeout, retries, and start period |
| Logs | Explicit rotation, initially `json-file`, `max-size: 10m`, `max-file: "3"` |
| Container | Unprivileged UID/GID; read-only root filesystem where supported |

Anvil checks `ss -ltnp` before selecting the port, records it, and rechecks before release. No port in the range is claimed free by this plan. Container port may be fixed internally; only the confirmed host port appears in Caddy.

Pin the Node image by digest and the accepted provider version exactly. Prove the service fits its memory/CPU budget under the measured OAuth workload.

### 7.2 Secrets and key rotation

Anvil generates the signing key on the box. Its source of truth is a 1Password item in **Yulan Ventures Infra**.

Deploy files under `/etc/commonswarm-oauth/`:

- Owner/group: `root:<service gid>`.
- Mode: `0640`.
- Read-only container mounts.
- Read through variables such as `MCP_OAUTH_SIGNING_KEYS_FILE`, `MCP_OAUTH_COOKIE_KEYS_FILE`, and `MCP_OAUTH_DATABASE_CREDENTIALS_FILE`.
- Environment values contain file paths, never secret material.

Private keys never reach the edge worker. JWKS exposes public keys only.

`kid` rotation is implemented from day one:

1. Generate/store/deploy the next key.
2. Publish its public key before using it.
3. Wait through the bounded JWKS cache interval.
4. Switch signing to the new `kid`.
5. Retain the previous public key for at least maximum token lifetime plus clock skew and cache propagation allowance.
6. Remove the old key only after overlap proofs.

Test both overlap and unknown-`kid` refresh. Emergency compromise response revokes affected grants/families as well as replacing keys.

### 7.3 Cloudflare and Caddy

Anvil creates proxied DNS for `mcp.commonswarm.com` using the live zone convention and production origin. Inspect existing certificate SANs; reuse a wildcard only if coverage is proven.

Install a hostname-scoped Cloudflare rule/configuration that skips **Browser Integrity Check and bot challenges for `mcp.commonswarm.com`**. Prove the effective rules cover discovery, authorization/token paths, and MCP. A browser-only smoke test is insufficient.

Test from outside the origin with a non-browser User-Agent, including a Python-style default UA, for:

- Protected-resource metadata.
- Authorization-server metadata.
- JWKS.
- Token endpoint.
- MCP endpoint.

Expected protocol responses include unauthenticated 401 or invalid-request errors; Cloudflare HTML challenges and error 1010 fail the test. Existing deployment documentation records a 1010 condition on staging (`deploy/RELEASE-TO-BOX.md:1426`).

Routing:

| Public route | Upstream |
|---|---|
| Exact `/mcp` | Edge loopback `9000`, MCP function |
| Protected-resource metadata path | Edge MCP metadata handler |
| Authorization-server/OIDC metadata | OAuth service on confirmed `349x` port |
| `/authorize`, `/token`, `/jwks` | OAuth service |
| `/interaction/*`, `/oauth/callback/gotrue` | OAuth service |
| Enumerated connection-management endpoints | OAuth service |

Enforce methods, body limits, bounded timeouts, and exact path rewrites. Preserve external host and scheme. Trust forwarding headers only from the configured proxy path. Do not log Authorization, cookies, codes, or sensitive query parameters.

### 7.4 Exact GoTrue change

The repository example currently contains the three existing entries at `deploy/supabase-stack/env.example:23`.

The required resulting value, when the live entries match that baseline, is exactly:

```text
GOTRUE_URI_ALLOW_LIST=https://commonswarm.com/app,https://www.commonswarm.com/app,http://127.0.0.1:*/callback,https://mcp.commonswarm.com/oauth/callback/gotrue
```

**Append, never replace existing entries.** Anvil compares the actual live value before changing it. If it contains additional entries, preserve all of them and append the new callback once; record the resulting non-secret value in release evidence.

This is a stack environment change with a stack release/rollback window. It is not a site environment change.

### 7.5 Migration versions and proofs

Allocate distinct 14-digit migration versions at integration time, in actual landing/release order. Do not reserve older timestamps for later lanes and create an out-of-order pending migration. The release procedure explicitly stops on unexplained older pending versions (`deploy/RELEASE-TO-BOX.md:971`).

Each migration includes these committed files:

```text
deploy/release-proofs/item-hm/<14-digit-version>-catalog.sql
deploy/release-proofs/item-hm/<14-digit-version>-functional.sql
deploy/release-proofs/item-hm/<14-digit-version>-rollback.sql
deploy/release-proofs/item-hm/<14-digit-version>-rollback-catalog.sql
```

The filenames are migration-version based, not `0.1.81-*`. Section 5 checks a 14-digit version and those exact catalog/functional filenames (`deploy/RELEASE-TO-BOX.md:1013`, `deploy/RELEASE-TO-BOX.md:1023`).

Expected migration groups:

1. Lane 4 transport.
2. Lane 2 authority/authentication/idempotency.
3. Lane 3 cursor/batches.
4. Lane 6 OAuth role/schema/store.
5. Any additional durable limit storage explicitly required by lane 7.

Catalog proofs cover owners, columns, constraints, indexes, RLS flags/policies, view definitions, function security/search paths, schema USAGE, table privileges, EXECUTE privileges, and negative privilege checks.

Forward catalog proofs terminate with a boolean `AS catalog_ok` and `\gset`; rollback catalogs similarly produce `rollback_ok`.

Rollback files are complete reviewed inverses. Lane 4’s inverse contains the full prior view definitions and ACL restoration. Lane 2 restores the live pre-HM idempotency constraint including `join`. OAuth role removal first proves it has no unexpected ownership, grants, or dependencies.

Run migrations through **RELEASE-TO-BOX section 5**, including catalog reconciliation, ledger handling, backup freshness, forward proofs, and abort cleanup. Never use linked Supabase commands.

Ensure the new schema and role are included in the nightly CommonSwarm backup and restore drill; prove restored credential state and role permissions. Backup freshness is a release gate, not a check-box assumption (`deploy/RELEASE-TO-BOX.md:919`).

### 7.6 Per-lane release windows

Every green lane is offered for release immediately, with its own exact SHA, applicable gates, proofs, rollback decision, and observation window.

“Released dark” means the compatible code/schema is live while public issuance or tool access remains disabled. It does not mean postponing deployment until all lanes finish.

Record separately:

- Reviewed and landed.
- Schema applied.
- Edge released.
- OAuth service released.
- Site released.
- Public activation enabled.
- Real-client verification passed.

Prefer compatible code rollback while retaining additive schema. Destructive schema rollback after credentials or seats exist requires HezLead’s explicit data-loss decision and a verified backup. Rolling back transport protection while hosted seats remain is prohibited.

## 8. Measurements and launch blockers

These are **NOT VERIFIED** until evidence is recorded:

| Measurement | Owner | Required disposition |
|---|---|---|
| Provider CIMD fetch replacement and refresh transaction | Lane S | PASS before accepting the library |
| Claude MCP revision, initialization, methods, sessions, Origin, retries | Tom/Anvil | Supported compatibility fixtures |
| Actual CIMD/client metadata and redirects | Tom/Anvil | Full authorization flow succeeds securely |
| Consent/GoTrue state round trip | Lane 6/8; Anvil live | No missing or substituted interaction binding |
| Rate and concurrency limits | Anvil plus implementation lead | Legitimate bursts succeed without starving edge functions |
| Warm/cold OAuth latency | Tom/Anvil | At least 50 representative flows; measured deadline margin |
| Port availability and certificate coverage | Anvil | Recorded before configuration is fixed |
| Cloudflare non-browser behavior | Anvil | No challenges on required endpoints |
| Key rotation and provider restart | Anvil | Existing valid tokens and refresh state behave as specified |
| Edge recycle with active check batch | Anvil | Same batch survives and ACK remains atomic |

No per-chat hint is an authentication boundary. Do not rely on an unverified Anthropic egress CIDR for access control.

GoTrue is used for human identity only. Replacing the dedicated authorization service with GoTrue is outside this plan; it would require a separate reviewed design and equivalent token-isolation proofs.

## 9. Continuous schedule and critical path

Start assumption: **2026-09-28**. These are calendar days with continuous agent work, not business days. Human review, CI capacity, and Anvil windows remain real dependencies.

Each lane budget includes implementation, an independent cross-family review, up to two correction rounds, applicable gates, integration, and a per-lane release window. A lane in review still occupies its slot. No third implementation stream runs in the lead column.

| Calendar days | Slot A | Slot B | Release activity |
|---|---|---|---|
| 1–3: Sep 28–30 | Lane 4 transport | Existing lane S spike | Release lane 4 when green; record spike result |
| 4–9: Oct 1–6 | Lane 2 authority/auth | Lane 5 infrastructure | Release each independently; hosted issuance stays disabled |
| 10–15: Oct 7–12 | Lane 3 durable check | Lane 6 OAuth service | Apply/release each lane with its proofs |
| 16–21: Oct 13–18 | Lane 7 MCP resource | Lane 8 consent/Connected apps | Release worker, service UI, and site as each becomes green |
| 22–25: Oct 19–22 | Integrated acceptance and scoped corrections | Independent review/retest as needed | Real Claude canary, rotation/recycle proofs, public activation |

**Expected ship range:** **2026-10-19 through 2026-10-25**, assuming the current provider spike passes, CI stays within budget, and operator/client access is available.

**Critical path:** lane 4 release → lane 2 release → the slower of lane 3 and accepted lane 6 → integrated lanes 7/8 → real-Claude and box acceptance.

Lane S becomes critical immediately if it fails or overruns. An alternate-provider evaluation adds an estimated **4–7 calendar days**, moving the conditional range to approximately **2026-10-23 through 2026-11-01**. This is a planning allowance, not a guarantee that an alternative will pass.

Release work is scheduled throughout. The final window is for integrated activation and measurement, not the first deployment of accumulated changes.

## 10. Done-test

HM is complete only when production evidence proves:

1. A fresh Claude connection adds `https://mcp.commonswarm.com/mcp`.
2. GoTrue sign-in is bound to the correct interaction and browser.
3. Missing, swapped, stale, replayed, and cross-origin consent tokens are rejected.
4. One-workspace and multi-workspace consent record one command per workspace; interrupted consent cannot issue a usable grant.
5. Two chats claim different seats and post agent-attributed notes.
6. Roster/feed show hosted, turn-only seats.
7. Same-key claiming returns the same live seat.
8. Concurrent claims create one seat/principal/handle.
9. All cross-path name races preserve hosted-name exclusivity.
10. The eleventh live hosted seat is refused, including cross-workspace races.
11. Non-consented, removed-member, archived, wrong-grant, and revoked-seat access is refused.
12. Hosted read and command paths make zero GoTrue identity calls.
13. Human bearers cannot execute hosted-only commands; seat handles cannot authenticate.
14. No credential appears in a model transcript or operational log.
15. `/app` grant revoke stops every seat on its next call while its JWT remains unexpired.
16. Seat revoke stops only that seat.
17. Owner self-revocation works after workspace departure.
18. Refresh replay returns `invalid_grant`, commits family revocation, and disables already-issued resource tokens.
19. Refresh consume/insert crash tests prove one pinned transaction.
20. CIMD attacks cannot trigger the provider’s original fetch or reach non-public destinations.
21. An unacknowledged check batch survives recycle and advances only after its valid ACK.
22. Same-millisecond cursor boundaries neither skip nor repeat committed rows.
23. Local CLI/MCP, packaging, existing command/read, and site gates remain green.
24. Non-browser Cloudflare probes reach protocol handlers without challenge pages.
25. Key rotation, container limits, loopback publication, backups, and restore permissions pass.
26. Every migration has forward and rollback proof artifacts.
27. Evidence records exact released SHAs, package version, migration versions, image digest, provider integrity, Claude revision, and per-lane release outcomes.

---

| Finding | Fix | Section |
|---|---|---|
| Hosted tool calls can fall through to human GoTrue authentication | Token-free internal entry points; runtime capabilities; transactional rechecks; public hosted-kind rejection before bearer auth | 2.2–2.5 |
| Human session can invoke new hosted commands | Two-way credential-kind checks in adapter and reducer; explicit public rejection | 2.2–2.3 |
| Lane 1 export cannot carry hosted context | Preserve landed public wrapper; add separate internal interfaces in lane 2 | 2.2, 4.1 |
| H0 bearer forwarding is unsafe precedent for HM | Explicitly prohibit copying that path | 2.1–2.2 |
| Obsolete principal-name constraint | Cite original constraint, dropped constraint, live advisory-lock/check, and duplicate exception | 3.3 |
| Grant-only lock permits duplicate-name races | Shared ceiling/name locks across all creation paths plus grant-cap lock | 3.3 |
| Local duplicate/H0 creation can collide with hosted seats | Reserve hosted names across those paths and test both race orders | 3.3 |
| Consent CSRF is only a test label | Host-only secure cookie, interaction/state/PKCE binding, synchronizer token, Origin validation, replay control | 5.1 |
| Multi-workspace command violates single-stream routing | Separate consent commands and receipts; final activation; truthful partial state | 3.1 |
| Invalid idempotency credential assumption | Preserve live `join`; explicitly migrate hosted namespaces | 2.3, 7.5 |
| Authority timestamps use moving wall clock | Persist reducer/server-time values; remove `clock_timestamp()` defaults | 3.4 |
| OAuth becomes a second writer in `swarm` | Separate credential schema; command-only authority writes | 3.5 |
| OAuth role lacks USAGE/RLS access | Explicit schema USAGE, table policies/grants, narrow status functions; no raw authority SELECT | 3.5 |
| Refresh callbacks may use different connections | Whole-request pinned connection; buffered response; committed replay revocation; crash/race proofs | 4.5, 5.3 |
| CIMD wrapper leaves original fetch active | Mandatory complete replacement; exact hook proof; library rejected if unavailable | 4.5, 5.4 |
| Library declared GO before compatibility proof | Candidate remains NOT VERIFIED; acceptance gated by separate spike | 4.5, 8 |
| Wake replacement drops predicates and exposes private view | No replacement SQL; preserve full live definition, barrier, owner, and revokes | 4.2 |
| Roster view invents `status` and loses membership semantics | Preserve live model/managed fields, archival-aware membership, registrar exclusion | 4.2 |
| Hosted seats precede transport protection | Lane 4 must land and release before lane 2 creation | 1, 4.2–4.3 |
| Principal INSERT omits transport fields | Event/reducer/SQL insertion updated together in lane 4 | 4.2 |
| Raw microsecond cursor mismatches reads | Truncated millisecond/UUID key throughout, with boundary tests | 4.4 |
| Wrong read handler/CORS facts | Cite landed wrapper and guarded serve; no lane 1 reimplementation | 4.1 |
| Incorrect package script lines | Correct `build:command-core`, `check:edge`, and literal test-list citations | 4.3, 4.8, 6 |
| Incorrect GoTrue ladder citations | Exact command `getUser`/`getClaims` and restricted human-read citations | 2.1 |
| Incorrect worker-limit citations | Correct 96 MiB, parallelism, and queue-timeout references | 4.6 |
| Proof filenames use package version | Four artifacts per 14-digit migration version; section 5 execution | 7.5 |
| Site tests assigned to mini | All browser/site tests explicitly routed to Actions `site` | 6 |
| PostgreSQL adapter tests assigned to root npm test | Separate Actions `server` gate with explicit service test wiring | 4.7, 6 |
| Docker-skipping tests treated as mini-safe | Complete CLI/container suite stays in Actions; no Docker availability probes on mini | 6 |
| Missing consent/Connected apps lane | Dedicated lane 8 with files, behavior, tests, dependencies, and release | 4.9 |
| Wrong service project/layout/port | Exact project and release layout; Anvil-confirmed loopback port in 3490–3499 | 7.1 |
| Wrong memory and unspecified runtime controls | 512m, ≤1 CPU, healthcheck, restart policy, explicit log rotation | 7.1 |
| Incomplete key handling | Box generation, named vault, required path/ownership/mode, read-only mounts and FILE variables | 7.2 |
| No operational `kid` rotation | Prepublish/switch/overlap/retire procedure and tests | 7.2 |
| Missing SCRAM/schema/backup requirements | Separate least-privilege role/schema, TLS/SCRAM, backup/restore proofs | 3.5, 7.5 |
| Missing Cloudflare non-browser exception | Hostname-scoped BIC/bot-challenge skip and external non-browser probes | 7.3 |
| GoTrue change omits exact variable/full value | Exact resulting allowlist plus preservation of additional live entries | 7.4 |
| One late batch deployment | Immediate per-lane dark releases with rollback/observation windows | 7.6, 9 |
| Third hidden implementation stream | Two staffed slots; infrastructure and UI are explicit lanes | 9 |
| Unrealistic ten-day schedule | Calendar schedule including review, correction, CI, releases, critical path and contingency | 9 |
| Nit: registration variant citation | Correct kind at `workspace-commands.ts:161`; creation behavior cited at `:738` | 3.3 |
| Nit: CheckState mistaken for persistence | Correct disk-path and deferred-write citations | 4.4 |
| Nit: stdio check citation | Correct deferred-commit case at `src/mcp/server.ts:127` | 4.4 |
| Nit: local tool assumptions cited at echo constant | Correct filesystem tool rows at `src/mcp/tools.ts:38` | 4.8 |
| Nit: agent revocation helper overstated | Explain separate membership input and token/run/device dependencies | 2.1 |
| Nit: workflow `on:` mistaken for suite choices | Correct choices at workflow line 30 and site execution at line 77 | 6 |