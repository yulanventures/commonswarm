### Security Review: Agent-Join Credential & Registrar (D-036)

---

### Analysis by Review Area

#### 1. Secret Handling
- **Generation & Redaction**: The secret is generated with `opaqueToken('swm_join_')` (32 random bytes, base64url, 43 chars) and verified via `AGENT_JOIN_CREDENTIAL_RE`. Redaction regex in `src/host/credential-redaction.ts` has been correctly updated to include `join`.
- **Storage**: Plaintext is never written to PostgreSQL. Only `credential_hash` (`sha256(secret)`) is persisted in `swarm.agent_join_credentials`.
- **Ledger & Audit**: The idempotency payload (`response`) stored in `swarm.idempotency_keys` strictly excludes `join_credential`, storing only safe metadata (`join_credential_id`, `locator`, `seat_cap`, `seats_used`, `expires_at`). Audit logs record only IDs and command metadata.
- **Replay**: Replay responses pull from `idempotency_keys` and pass through `storedResponse`, ensuring the raw secret cannot be re-issued upon replay or conflicting retry (which returns 409). The secret is returned solely in the initial HTTP 200 response body.

#### 2. The Schema & Immutability Trigger
- **Table Constraints**: `seat_cap` is bounded (1..10), `seats_used` is constrained `BETWEEN 0 AND seat_cap`, and `expires_at` is constrained to `(created_at, created_at + interval '24 hours']`. All IDs, hashes, and locators are uniquely constrained.
- **Trigger Coverage**: `swarm.agent_join_credentials_guard()` blocks `DELETE` unconditionally. It forbids changes to all identity and configuration columns (`id`, `workspace_id`, `owner_user_id`, `registrar_principal_id`, `registrar_run_id`, `credential_hash`, `locator`, `seat_cap`, `expires_at`, `created_at`, `mint_command_id`). It prevents `seats_used` from decrementing or changing during/after revocation, and prevents un-revoking.
- **Gap**: The trigger guards `seats_used` changes against revocation (`revoked_at IS NOT NULL`), but does **not** check expiration (`OLD.expires_at <= statement_timestamp()`).

#### 3. Privileges & RLS
- **Direct Access**: `REVOKE ALL ON TABLE swarm.agent_join_credentials FROM PUBLIC, anon, authenticated;` is enforced. RLS is enabled with only a permissive policy for `swarm_command`.
- **Command Role**: `swarm_command` is granted `SELECT, INSERT, UPDATE` (no `DELETE` or `TRUNCATE`), matching its operational requirements.
- **Views**: Views in `swarm_read` (`agent_principals`, `agent_runs`, `my_devices`) use `security_barrier = true` and only query `agent_join_credentials` inside `NOT EXISTS` subqueries to filter hidden service rows. No credential fields are published.

#### 4. The Registrar
- **Atomicity**: The registrar device, principal, run, and join credential are created within the same database transaction (`tx`), backed by composite foreign keys (`agent_principals_principal_workspace_owner` and run-to-principal).
- **Influence**: Registrar naming (`join-registrar-${joinCredentialId}`) and device label are server-generated from random UUIDs. Workspace and owner IDs are bound to verified auth context.
- **Revocation Scope**: Calling `revoke_agent_join_credential` strictly ends the registrar run, revokes the registrar principal, and revokes the registrar device. It does not touch any joined agent seats or other workspace resources.

#### 5. Quota and Abuse
- **Teammate DoS & Missing Per-User Bounds**: The code comment references "§5's no-teammate-DoS rule: (a) is per-issuing-identity and re-mintable after the window, (b) is a resource-creation ceiling". However, (a) is completely absent. Any workspace member can mint without rate limiting or active-credential quotas.
- **Permanent Quota Leak on Expiration**: Registrar principals count against `FREE_TIER_PRINCIPAL_LIMIT` via `p.revoked_at IS NULL`. When credentials expire naturally, their registrar principals are never revoked, permanently consuming workspace principal quota.
- **Ceiling Bypass via Concurrency**: The preflight `count(*)` read in `mintAgentJoinCredential` takes no locks under `READ COMMITTED` isolation, enabling concurrent requests to bypass the 50-principal ceiling.

---

### Findings

#### [PRODUCTION] 1. Permanent Principal Quota Exhaustion on Credential Expiration (Workspace DoS)
- **Impact**: When a join credential expires naturally (`expires_at <= now()`), no background process, trigger, or server check updates `revoked_at` on the underlying registrar principal (`swarm.agent_principals`). Because quota is calculated via `SELECT count(*) FROM swarm.agent_principals WHERE workspace_id = $1 AND revoked_at IS NULL`, expired registrar principals continue to consume principal slots indefinitely.
- **Compounding Visibility Issue**: Registrar principals are filtered out of `swarm_read.agent_principals`, and there is no view or command to list join credentials. Workspace owners and admins have no way to view these dead principals or discover their `join_credential_id`s to revoke them, permanently bricking workspace agent creation once 50 credentials have ever expired.

#### [PRODUCTION] 2. Unbounded Minting by Unprivileged Members Violates No-Teammate-DoS
- **Impact**: Any workspace member (`auth.credentialKind === "user"`) can call `mint_agent_join_credential`. There is no role check (admin/owner not required), no limit on concurrently active credentials per user or workspace, and no rate limit or cooldown. A single non-admin member can call `mint_agent_join_credential` 50 times in a loop, exhausting the workspace's entire 50-principal ceiling and blocking all teammates from creating agents.

#### [PRODUCTION] 3. Race Condition Bypasses the 50-Principal Quota Ceiling
- **Impact**: In `mintAgentJoinCredential`, `SELECT count(*)::text AS live FROM swarm.agent_principals WHERE workspace_id = $1 AND revoked_at IS NULL` runs under PostgreSQL's default `READ COMMITTED` transaction isolation without locking the workspace row (e.g. `SELECT 1 FROM swarm.workspaces WHERE workspace_id = $1 FOR UPDATE`) or obtaining an advisory lock. Concurrent mint requests will both observe `live < FREE_TIER_PRINCIPAL_LIMIT` and successfully insert, allowing callers to exceed the 50-principal ceiling.

#### [PRODUCTION] 4. Quota Decoupling Between Seat Cap and Principal Limit
- **Impact**: `mintAgentJoinCredential` only checks if `live < FREE_TIER_PRINCIPAL_LIMIT` (accounting for 1 registrar slot), but allows minting credentials with `seat_cap` up to 10. A user can mint credentials up to the ceiling (e.g., 49 credentials with `seat_cap = 10` = 490 potential seats in a 50-seat workspace). Because headroom is not reserved or validated against the ceiling at mint time, invitations can be distributed to external agents that will predictably fail at registration time, or overcommit workspace capacity.

#### [RIGOUR] 1. Database Trigger Fails to Block `seats_used` Mutations on Expired Credentials
- **Impact**: `swarm.agent_join_credentials_guard()` prevents modifying `seats_used` once `revoked_at` is set, but does not assert `statement_timestamp() < OLD.expires_at`. While future registration logic will likely filter by `expires_at > statement_timestamp()`, the database trigger fails to enforce TTL expiration as an invariant on seat consumption.

#### [RIGOUR] 2. Unauthorized Revocation Audit Reason / HTTP Status Discrepancy
- **Impact**: In `revokeAgentJoinCredential`, if an unauthorized member attempts to revoke another user's credential, the handler audits `outcome: "authz", reason: "agent_join_credential_not_found"` while returning HTTP 403 `forbidden`. While returning 403 avoids leaking existence over HTTP, logging `not_found` internally instead of an authorization refusal obscures auditability of permission violations.

---

VERDICT: FAIL - Expired credentials permanently leak principal quota, unprivileged members can exhaust workspace quota unbounded, and concurrent mints bypass the principal ceiling.
