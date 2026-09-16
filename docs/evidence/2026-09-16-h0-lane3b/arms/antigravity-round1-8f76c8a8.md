### PRODUCTION Findings

#### Finding 1: Deadlock between `register_agent_seat` and `revoke_agent_join_credential`
* **Classification:** PRODUCTION
* **Diff Hunk:** `supabase/functions/command/index.ts:5878-5902`
  ```typescript
  async function registerAgentSeat(
    tx: Sql,
    body: RequestBody,
    credentialHash: Uint8Array,
  ): Promise<HttpResult> {
    const credential = await lockJoinCredential(tx, credentialHash);
    if (
      credential === null || credential.revoked_at !== null ||
      credential.unexpired !== true
    ) {
  ...
    const frame = await lockRegistrationStream(tx, route);
    if (!await lockJoinCredentialOwnerMembership(tx, credential)) {
  ```
* **Concrete Sequence:**
  1. `registerAgentSeat` locks the target row in `swarm.agent_join_credentials` `FOR UPDATE` via `lockJoinCredential` (line 5878).
  2. Afterward, `registerAgentSeat` locks the workspace stream row in `swarm.streams` `FOR UPDATE` via `lockRegistrationStream` (line 5899).
  3. Meanwhile, `revoke_agent_join_credential` is a regular `WorkspaceCommand`. All workspace commands take the workspace stream lock (`swarm.streams` `FOR UPDATE`) first, before executing the command and updating database rows. When `revoke_agent_join_credential` reduces, it updates `swarm.agent_join_credentials` (`UPDATE swarm.agent_join_credentials SET revoked_at = ... WHERE id = ...`), requiring the row lock on `swarm.agent_join_credentials`.
  4. Concurrent execution of `register_agent_seat` and `revoke_agent_join_credential` for the same credential causes an inverted lock order:
     * Transaction 1 (`register_agent_seat`) holds `agent_join_credentials` and waits on `swarm.streams`.
     * Transaction 2 (`revoke_agent_join_credential`) holds `swarm.streams` and waits on `agent_join_credentials`.
  5. PostgreSQL triggers a deadlock detection abort (`40P01: deadlock_detected`).
* **User / Attacker Observation:** An honest user or agent attempting to register while a join credential is being revoked experiences an unhandled transaction failure resulting in an HTTP 500 internal server error instead of orderly serialization (where registration either succeeds before revocation or cleanly fails with 403).

---

#### Finding 2: Replay Fails to Return Stored Idempotency Response, Prematurely Revoking Tokens
* **Classification:** PRODUCTION
* **Diff Hunk:** `supabase/functions/command/index.ts:5956-6015`
  ```typescript
    const commandId = String(body.command_id);
    const hash = requestHash(auth.actor, command);
    const ledgerRows = await tx<{
      request_hash: string;
      workspace_id: string;
      stream_id: string;
    }[]>`
      SELECT request_hash, workspace_id, stream_id
      FROM swarm.idempotency_keys
      WHERE principal_kind = 'join'
        AND principal_id = ${credential.id}
        AND command_id = ${commandId}
      LIMIT 1
    `;
    const ledger = ledgerRows[0];
    if (
      ledger && (
        ledger.request_hash !== hash ||
        ledger.workspace_id !== credential.workspace_id ||
        ledger.stream_id !== credential.stream_id
      )
    ) {
      await insertAudit(...);
      return { status: 409, body: { error: "command_id_conflict" } };
    }

    const attemptRows = await tx<ExistingJoinAttempt[]>`
  ```
* **Concrete Sequence:**
  1. An agent registers with `command_id = C1` and `attempt_id = A1`. The transaction succeeds, minting token `T1`, storing the replay-safe response in `swarm.idempotency_keys`, and returning `T1`'s raw secret in the fresh response.
  2. If the response is dropped by a network glitch, or if a client library automatically replays the exact HTTP request (`command_id = C1`, `attempt_id = A1`), `registerAgentSeat` executes again.
  3. It finds `ledger` in `swarm.idempotency_keys`. Because `request_hash`, `workspace_id`, and `stream_id` match, it passes the conflict check.
  4. However, `registerAgentSeat` **never selects `response` and never returns the stored response**. Execution falls through to `attemptRows`.
  5. `attemptRows` finds attempt `A1`:
     * If the agent has not yet used token `T1` (`first_used_at IS NULL`), it calls `replaceUnusedRegistrationToken`. This revokes `T1` and mints a new token `T2`. If the agent had actually received `T1` and was about to use it, `T1` is invalidated behind its back.
     * If the agent already used `T1` (`first_used_at IS NOT NULL`), it rejects with HTTP 409 `registration_token_already_used` instead of returning HTTP 200 with the stored response.
* **User / Attacker Observation:** Replaying an identical idempotent command never returns the cached response. Honest clients retransmitting due to network drops either have their valid token silently revoked before first use or receive a spurious 409 error after using it.

---

#### Finding 3: H0 Seat Minted with Renewal Grant Permitting Lifetime Extension
* **Classification:** PRODUCTION
* **Diff Hunk:** `supabase/functions/command/index.ts:6205-6238` and `5824-5843`
  ```typescript
    await tx`
      INSERT INTO swarm.renewal_grants (
        renewal_grant_id, workspace_id, principal_id, run_id,
        kind, max_successors, successors_used, horizon_expires_at,
        bound_device_id, created_by
      ) VALUES (
        ${grantId}::uuid,
        ${credential.workspace_id}::uuid,
        ${principalId}::uuid,
        ${runId}::uuid,
        'timeboxed',
        ${RENEWAL_MAX_SUCCESSORS_DEFAULT},
        0,
        ${new Date(frame.now + RENEWAL_HORIZON_DEFAULT_MS)},
        NULL,
        ${credential.owner_user_id}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, task_id, epoch,
        scopes, token_hash, issued_at, expires_at, lineage_id,
        renewal_grant_id
      ) VALUES (
        ${tokenId}::uuid,
        ${principalId}::uuid,
        ${runId}::uuid,
        ${command.attempt_id}::uuid,
        0,
        ${tx.json([...P0_AGENT_SCOPES])}::jsonb,
        ${tokenHash},
        ${new Date(frame.now)},
        ${expiresAt},
        ${lineageId}::uuid,
        ${grantId}::uuid
      )
    `;
  ```
* **Concrete Sequence:**
  1. The specification requires: *"Seat lifetime, by Strategist ruling 2026-09-16: H0_SEAT_TOKEN_TTL_MS = AGENT_TOKEN_MAX_TTL_MS (30 days). No renew verb, and nothing re-registers a seat... Nothing renews or re-registers an H0 seat; used attempt replays stay refused."*
  2. In `registerAgentSeat` (and during replacement in `replaceUnusedRegistrationToken`), an active timeboxed `renewal_grant` is inserted into `swarm.renewal_grants` and linked to the agent token via `renewal_grant_id`.
  3. The `/command` endpoint on main includes `renew_agent_token` (`type ConnectCommand = ... | { kind: "renew_agent_token" }`). This command authenticates the bearer token, checks `loadRenewalFacts`, and mints successor tokens if `renewal_grant_id` is present and active.
  4. An AI agent possessing an H0 token can call `renew_agent_token` directly against the `/command` endpoint. Because the database contains an active renewal grant with `RENEWAL_MAX_SUCCESSORS_DEFAULT`, the server grants renewal and extends the seat beyond the mandatory 30-day cap.
* **User / Attacker Observation:** An agent can renew its token and remain active in the workspace indefinitely past the 30-day maximum lifetime without requiring a human to re-invite it.

---

#### Finding 4: Owner Rights Check Bypassed via Hardcoded `humanRights`
* **Classification:** PRODUCTION
* **Diff Hunk:** `supabase/functions/command/index.ts:6120-6130` vs `src/protocol/workspace-commands.ts:727-735`
  ```typescript
    const ctx: WorkspaceDecideCtx = {
      now: frame.now,
      actor: auth.actor,
      credential_kind: "join",
      presenting_token_id: null,
      command_id: commandId,
      workspace_id: credential.workspace_id,
      stream_id: credential.stream_id,
      operatorAllowed: () => false,
      role: (userId) => {
        const member = state.members[userId];
        return member?.revoked_at === null ? member.role : null;
      },
      inviteeAlreadyMember: () => false,
      identityVerified: () => false,
      humanRights: () => [...P0_AGENT_SCOPES],
      landingAuthorityChangeResolved: () => false,
      nextSeq: () => ++nextSeq,
      nextEventId: () => crypto.randomUUID(),
    };
  ```
* **Concrete Sequence:**
  1. `decideWorkspace` contains an explicit authorization check:
     ```typescript
     const humanRights = new Set(ctx.humanRights(ctx.actor));
     if (cmd.scopes.some((scope) => !humanRights.has(scope))) {
       return domain(ctx, cmd.kind, 'scope_not_allowed', 'registration scopes exceed the credential owner rights');
     }
     ```
  2. However, in `registerAgentSeat`, `ctx.humanRights` is mocked as `() => [...P0_AGENT_SCOPES]`, rather than evaluating the human owner's actual rights in `state`.
  3. If a human workspace member has restricted rights (or their role was downgraded to a read-only role after minting the join credential), registration still assigns the agent all `P0_AGENT_SCOPES`.
  4. Furthermore, `replaceUnusedRegistrationToken` hardcodes `scopes: [...P0_AGENT_SCOPES]` directly into SQL without invoking `decideWorkspace` or checking human rights.
* **User / Attacker Observation:** A human user whose permissions do not include all `P0_AGENT_SCOPES` can mint a join credential that registers an agent possessing scopes the user does not have.

---

#### Finding 5: Token Replacement Resurrects Intentionally Revoked Seats
* **Classification:** PRODUCTION
* **Diff Hunk:** `supabase/functions/command/index.ts:5800-5820`
  ```typescript
    const revoked = await tx<{ token_id: string }[]>`
      UPDATE swarm.agent_tokens
      SET revoked_at = coalesce(revoked_at, ${new Date(frame.now)})
      WHERE token_id = ${existing.token_id}::uuid
        AND principal_id = ${existing.principal_id}::uuid
        AND run_id = ${existing.run_id}::uuid
        AND first_used_at IS NULL
      RETURNING token_id
    `;
  ```
* **Concrete Sequence:**
  1. An agent seat is registered with `attempt_id = A1` (principal `P1`, token `T1`).
  2. Before the token is used (`first_used_at IS NULL`), a human administrator spots an issue and revokes the token (or revokes principal `P1`), setting `T1.revoked_at`.
  3. The agent retries `register_agent_seat` with the same `attempt_id = A1`.
  4. `replaceUnusedRegistrationToken` executes:
     `UPDATE swarm.agent_tokens SET revoked_at = coalesce(revoked_at, ...) WHERE ... AND first_used_at IS NULL`.
     Because `first_used_at` is NULL and `coalesce` preserves the existing `revoked_at`, this UPDATE matches (`revoked.length === 1`).
  5. It does not check whether `principal_id` or `existing.token_id` was already revoked, nor does it pass through `decideWorkspace`. It mints a fresh, unrevoked token `T2` for `P1` and updates `agent_join_attempts`.
* **User / Attacker Observation:** An administrator who explicitly revokes an unused seat or token finds that re-submitting the registration attempt re-activates the seat with a newly minted, unrevoked token secret.

---

### RIGOUR Findings

#### Finding 6: Missing Composite Unique Constraint on `swarm.agent_principals`
* **Classification:** RIGOUR
* **Diff Hunk:** `supabase/migrations/20260916000002_agent_join_attempts.sql:26-30`
  ```sql
    FOREIGN KEY (principal_id, workspace_id, owner_user_id)
      REFERENCES swarm.agent_principals (
        principal_id, workspace_id, owner_user_id
      ),
  ```
* **Mechanism:**
  The migration explicitly adds supporting composite unique indexes for `agent_join_credentials (id, workspace_id, owner_user_id)` and `agent_tokens (token_id, principal_id, run_id)`. However, it does not create a composite unique index on `swarm.agent_principals (principal_id, workspace_id, owner_user_id)`. If `swarm.agent_principals` on main only has a primary key on `principal_id`, PostgreSQL will reject the foreign key constraint during migration execution with error `42830: there is no unique constraint matching given keys for referenced table`.

---

#### Finding 7: Redundant Stream Head Lock Invocations in Domain Refusal and Token Replacement Paths
* **Classification:** RIGOUR
* **Diff Hunk:** `supabase/functions/command/index.ts:5738`, `5800`, `5899`
  ```typescript
    const frame = await lockRegistrationStream(tx, route);
  ```
* **Mechanism:**
  `registerAgentSeat` acquires the workspace stream lock at line 5899 (`const frame = await lockRegistrationStream(tx, route);`). Both `refuseRegistrationDomain` (called from lines 6013, 6046, 6068) and `replaceUnusedRegistrationToken` (called from line 6032) re-query `lockRegistrationStream(tx, route)` within the same transaction. While PostgreSQL permits re-locking an already locked row in Read Committed isolation, re-reading `head_seq` and calculating a new `frame.now` causes redundant database round-trips and creates split-horizon timestamp values across event envelopes in a single registration invocation.

---

VERDICT: FAIL
The change deadlocks under concurrent revocation, breaks HTTP command idempotency by destroying tokens on replay, opens an unauthorized renewal backdoor on H0 seats, and bypasses credential owner scope boundaries.
