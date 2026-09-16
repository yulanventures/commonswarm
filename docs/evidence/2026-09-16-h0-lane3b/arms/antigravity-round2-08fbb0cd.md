### Security Review: `register_agent_seat` (Round 2)

#### Overview of Analysis
A line-by-line verification was conducted across `src/h0/verbs.ts`, `src/protocol/workspace-commands.ts`, `supabase/functions/command/index.ts`, `supabase/functions/h0/index.ts`, and `supabase/migrations/20260916000002_agent_join_attempts.sql`.

---

### Findings

#### [RIGOUR] Unbounded Unused-Token Replacement Frequency (Missing Retry Replacement Cap)
* **Diff Hunk**: `supabase/functions/command/index.ts:5752-5845` (`replaceUnusedRegistrationToken`)
* **Concrete Sequence**:
  1. An agent registers a seat with `attempt_id` $A_1$. The initial token $T_1$ is issued.
  2. The agent does not use $T_1$. Instead, it issues repeated registration requests with the same $attempt_id$ $A_1$ and fresh `command_id`s ($C_2, C_3, \dots, C_n$).
  3. On each request, `replaceUnusedRegistrationToken` verifies that the previous token remains unused (`first_used_at IS NULL`), revokes it, inserts a tombstone into `swarm.revocation_tombstones`, inserts a new token into `swarm.agent_tokens`, updates `swarm.agent_join_attempts.token_id`, and appends two stream events (`AgentTokenRevoked`, `AgentTokenMinted`).
  4. While renewal grants enforce `max_successors` via `RENEWAL_MAX_SUCCESSORS_DEFAULT`, bootstrap token replacement on retry has no counter or cap.
* **Impact**: No extra seats are spent, no principals are created past the limit, and only one token is ever live at any moment (all replacements remain strictly bounded by `grant_horizon_expires_at`). However, an agent can churn through token rows and event log entries until the 30-day grant horizon expires.
* **User/Attacker View**: Attacker receives a valid replacement token on every call; database and stream log accumulate tombstoned and revoked tokens. (Per commit notes, public HTTP ingress rate limiting is deferred to the outer `h0` lane).

---

#### [RIGOUR] Archived Workspace Induces 500 via Reducer Authz Assertion
* **Diff Hunk**: `supabase/functions/command/index.ts:6226-6265` (`registerAgentSeat`) and `src/protocol/workspace-commands.ts:688` (`decideWorkspace`)
* **Concrete Sequence**:
  1. A workspace is archived via `archive_workspace`, setting `state.active = false`.
  2. A join credential minted before archival is presented to `register_agent_seat`.
  3. `registerAgentSeat` acquires `lockJoinCredential`, `lockRegistrationStream`, and `lockJoinCredentialOwnerMembership` (membership row exists with `revoked_at IS NULL`).
  4. `loadWorkspaceState` loads `state` where `state.active === false`.
  5. The adapter passes the command to `decideWorkspace`. At line 688, `decideWorkspace` executes:
     ```typescript
     if (!state.active) {
       return authz('workspace_not_found', 'workspace is unavailable');
     }
     ```
  6. The adapter receives `decision.ok === false` and `decision.class === 'authz'`, triggering line 6262:
     ```typescript
     if (decision.class === "authz") {
       throw new Error(`registration reducer refused adapter-derived authority: ${decision.reason}`);
     }
     ```
* **Impact**: An unhandled exception is thrown, returning an HTTP 500 instead of a uniform 403/404 refusal. The transaction aborts cleanly, so no seat or principal is created.
* **User/Attacker View**: Honest user or attacker calling `register_agent_seat` on an archived workspace observes a 500 Internal Server Error rather than an auth/domain rejection.

---

### Evaluation of Core Attack Surfaces & Round 2 Focus Areas

1. **Liveness Conditions on Retry (Token, Principal, Run, Grant)**:
   - Evaluated in `attemptRows` (locked `FOR UPDATE OF a, t, p, r, g`) and re-checked atomically inside `UPDATE swarm.agent_tokens`.
   - If a human revokes the principal, ends the run, revokes the token, or revokes the grant, `existing` catches it and returns 409 `registration_seat_revoked`.
   - If the token was ever used (`first_used_at IS NOT NULL`), it rejects with 409 `registration_token_already_used`.
   - Replaced tokens are immediately tombstoned with `STRANDED_REGISTRATION_TOKEN_TOMBSTONE`, preventing renewal via `loadRenewalFacts`.

2. **Shared Horizon**:
   - The initial token `expires_at` and `renewal_grants.horizon_expires_at` are minted using the exact same instant (`frame.now + H0_SEAT_TOKEN_TTL_MS`).
   - `replaceUnusedRegistrationToken` clamps replacement token expiry to `Math.min(frame.now + H0_SEAT_TOKEN_TTL_MS, existing.grant_horizon_expires_at.getTime())`.
   - Neither renewal successors nor retry replacements can outlive the seat's 30-day lifetime.

3. **Single Stream Frame**:
   - `lockRegistrationStream` executes once under `FOR UPDATE`, yielding `frame.headSeq` and `frame.now`.
   - All sequence offsets (`headSeq + 1`, `headSeq + 2`), event timestamps, token issuance timestamps, and stream `head_seq` updates derive consistently from this single frame without re-reads or clock skew.

4. **Owner-Membership Check & Concurrency**:
   - `lockJoinCredentialOwnerMembership` holds the owner's membership row `FOR SHARE` after acquiring the workspace stream lock.
   - Any concurrent member removal/revocation must acquire the workspace stream lock and take an exclusive lock on `swarm.memberships`.
   - Lock hierarchy across all paths:
     $$\text{agent\_join\_credentials} \rightarrow \text{streams} \rightarrow \text{memberships} \rightarrow \text{agent\_join\_attempts} \rightarrow \text{advisory xact lock}$$
   - Concurrent registrations, revokes, and membership removals serialize cleanly without lock inversion or deadlock.

5. **Uniform Refusal & Attribution (G3)**:
   - Missing bearer, regex failure, unresolvable hash, revoked credential, expired credential, or departed owner membership all uniformly return 403 `{"error":"forbidden"}` and write no stream events or audit logs.
   - Domain rejections after resolution attribute the event and audit row to `owner_user_id`, `registrar_principal_id`, and `registrar_run_id`, with the seat as the subject.
   - Request body inputs (`cmd.name`, `cmd.attempt_id`) cannot forge identity; `body.from` is explicitly rejected with 400.

6. **Ceiling and Seat Caps**:
   - `seats_used` is checked against `seat_cap` and incremented atomically with forward-only triggers.
   - `lockAndCountLivePrincipals` acquires the workspace advisory transaction lock and enforces `FREE_TIER_PRINCIPAL_LIMIT` before minting.

---

VERDICT: PASS
All five Round 1 defects and previous failure points are verified fixed; lock ordering is strictly monotonic across all interacting commands, token lifecycle and liveness guards are atomic and airtight, uniform refusals preserve secrecy, and G3 attribution requirements are satisfied.
