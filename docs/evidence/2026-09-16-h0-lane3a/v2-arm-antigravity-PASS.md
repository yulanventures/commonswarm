### Findings

**PRODUCTION**: None.

**[RIGOUR] Server concurrency test cannot detect lock regressions locally**
* Citation: `tests/p1-server/agent-join-credential.test.ts:654-666` and commit message lines 73–79.
* Details: The server test `"six concurrent mints with room for one produce exactly one registrar"` passes even if `pg_advisory_xact_lock` is completely deleted (as confirmed by the lead's mutation tests), because the local Deno/edge test runner does not interleave concurrent HTTP handler transactions. The commit author documented this and added an AST structural test (`tests/p1-cli/agent-join-credential.test.ts:89-133`) to verify lock presence and ordering. However, this means the behavioural test suite cannot observe real database race conditions in local testing.

**[RIGOUR] AST lock test relies on exact SQL string matching**
* Citation: `tests/p1-cli/agent-join-credential.test.ts:112-117`.
* Details: The AST visitor searches for `/count\(\*\)/i.test(text) && /swarm\.agent_principals/.test(text)` and `/pg_advisory_xact_lock/.test(text) && /principal-ceiling/.test(text)`. If a developer later formats the query as `count(1)` or `count(p.principal_id)`, or reformats table names, the AST test would fail to recognize the count, even if functionally identical.

---

### Detailed Analysis of Questions

#### 1. Are findings 1–3 actually closed?
**Yes, all three findings are closed.**

* **Finding 1 (Expired registrars holding slots forever):** Closed. In `supabase/functions/command/index.ts:5442-5448`, `lockAndCountLivePrincipals` excludes any registrar where `c.expires_at <= statement_timestamp()`. As soon as a credential's TTL lapses, its registrar is immediately ignored by the ceiling count.
* **Finding 2 (Unbounded minting):** Closed. Lines 709–711 define `AGENT_JOIN_LIVE_PER_USER_LIMIT = 5` and `AGENT_JOIN_LIVE_PER_WORKSPACE_LIMIT = 20`. Lines 5542–5569 query `liveCredentials` for unrevoked, unexpired credentials and reject with 403 `join_credential_limit_reached` (`scope: "identity" | "workspace"`) if either cap is reached. Because the workspace cap is 20, registrars can never consume more than 20 slots of the 50-slot ceiling (`FREE_TIER_PRINCIPAL_LIMIT`), guaranteeing at least 30 slots for regular agents.
* **Finding 3 (READ COMMITTED count race):** Closed. Lines 5429–5434 take `SELECT pg_advisory_xact_lock(hashtext(${workspaceId}::text), hashtext('principal-ceiling'))` before counting. In Postgres `READ COMMITTED`, this serializes all ceiling checks for the workspace; any concurrent transaction blocks until the active one commits, seeing its inserted principal.

**Attempted Failure Sequences:**
* *Sequence A (Exhausting ceiling via mints):* User mints 5 credentials. Attempting a 6th hits `mine >= 5` (403). Four users mint 5 each (20 total). A 5th user attempts to mint and hits `inWorkspace >= 20` (403). At this point, exactly 20 registrar slots are taken; 30 remain. The ceiling cannot be exhausted by credentials.
* *Sequence B (Expired credentials blocking agents):* 20 credentials expire. Their registrars remain in `swarm.agent_principals` with `revoked_at IS NULL`. A user calls `create_agent_principal`. `lockAndCountLivePrincipals` executes: for each expired registrar, `c.expires_at <= statement_timestamp()` is true, so `NOT EXISTS` evaluates to false. None of the 20 expired registrars are counted (`live = 0` + existing regular agents). Agent creation succeeds.
* *Sequence C (Concurrent mints / creates racing the ceiling):* Transaction A and B both attempt to mint when `live = 49`. Both call `lockAndCountLivePrincipals`. Transaction A acquires the advisory lock; Transaction B blocks. Transaction A counts 49, passes, inserts registrar (count is now 50), and commits. Transaction B unblocks, its transaction snapshot reads the newly committed registrar, counts 50, and triggers `live >= FREE_TIER_PRINCIPAL_LIMIT` (403).

---

#### 2. Shared helper exclusion logic
In `supabase/functions/command/index.ts:5437-5449`:
```sql
SELECT count(*)::text AS live
FROM swarm.agent_principals AS p
WHERE p.workspace_id = ${workspaceId}::uuid
  AND p.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM swarm.agent_join_credentials AS c
    WHERE c.registrar_principal_id = p.principal_id
      AND (c.revoked_at IS NOT NULL OR c.expires_at <= statement_timestamp())
  )
```

* **Can a LIVE registrar go uncounted?** No. For a live registrar, `c.revoked_at` is `NULL` and `c.expires_at > statement_timestamp()`. The subquery returns 0 rows, `NOT EXISTS` is true, and `p.revoked_at` is `NULL`. The live registrar is counted.
* **Can a DEAD registrar stay counted?** No. If a registrar is dead because it was explicitly revoked, either `p.revoked_at IS NOT NULL` (excluded by the outer `WHERE`) or `c.revoked_at IS NOT NULL` (subquery matches, `NOT EXISTS` is false). If it is dead because it expired, `c.expires_at <= statement_timestamp()` matches, `NOT EXISTS` is false, and it is excluded.
* **Can a non-registrar principal be excluded wrongly?** No. A non-registrar principal (created via `create_agent_principal` or normal agent flows) does not have its `principal_id` stored in `swarm.agent_join_credentials.registrar_principal_id`. The subquery is unconditionally empty for non-registrar principals, making `NOT EXISTS` evaluate to true. They are counted as long as their own `p.revoked_at IS NULL`.

---

#### 3. Advisory lock evaluation
* **Correct key:** Lines 5430–5433 use `pg_advisory_xact_lock(hashtext(${workspaceId}::text), hashtext('principal-ceiling'))`. In PostgreSQL, `hashtext` returns `integer` (int4). This correctly matches the two-argument signature `pg_advisory_xact_lock(int4, int4)`, scoping the lock to `(workspace_id, 'principal-ceiling')`. Transaction-level scoping (`xact_lock`) guarantees release upon commit or rollback.
* **Taken before every count:** Yes. Line 5429 awaits the lock query before line 5435 sends the count query.
* **No path around it:** The AST test (`tests/p1-cli/agent-join-credential.test.ts:89-133`) proves that the command edge contains exactly one `count(*)` over `swarm.agent_principals`, located inside `lockAndCountLivePrincipals`, and both `mintAgentJoinCredential` (line 5541) and `create_agent_principal` (line 6913) call this helper.
* **No deadlock with per-name lock:** Consistent lock hierarchy. In `create_agent_principal`, `enforceFreeTierBudget` executes before principal insertion, acquiring the workspace ceiling lock first; the per-name lock is taken later. `mintAgentJoinCredential` only takes the ceiling lock. Since all paths acquire the ceiling lock first, lock inversion cannot occur.

---

#### 4. Safety of decision on #4 (no reservation at mint)
**Yes, the decision is safe.**
1. Registration does not exist yet ("NOT ESTABLISHED: registration (nothing consumes a seat yet)"), so no mechanism exists to claim seats beyond the single registrar principal created at mint.
2. The registrar principal itself is counted against the 50-principal ceiling via `lockAndCountLivePrincipals`.
3. Over-allocation of seats at mint time is safe because the 20-credential workspace cap limits total registrar overhead to 20 slots.
4. When the registration lane is built, the requirement is explicitly documented in the mint handler comment (lines 5536–5540): each registration must check against the principal ceiling at registration time and refuse cleanly if full.

---

#### 5. Trigger refusal on expired credentials
In `supabase/migrations/20260916000001_agent_join_credentials.sql:89`:
```sql
OR (NEW.seats_used > OLD.seats_used AND OLD.expires_at <= statement_timestamp())
```
* **Correct:** Yes. Any update attempting to increment `seats_used` when `OLD.expires_at <= statement_timestamp()` causes the trigger to abort with `SWARM_AGENT_JOIN_CREDENTIAL_IMMUTABLE`.
* **Sufficient:** Yes, for table-level seat consumption invariants. Decrementing is blocked by `NEW.seats_used < OLD.seats_used`, spending seats on revoked credentials is blocked by lines 90–93, and extending expiry is blocked by `expires_at` immutability. The test in `tests/p1-server/agent-join-credential.test.ts:607-620` verifies both negative rejection on expired credentials and positive acceptance on live credentials.

---

#### 6. Can any new test pass while its property is broken?
* **Yes:** As noted in [RIGOUR] and explicitly admitted in the commit message (lines 73–79) and test comment (`tests/p1-server/agent-join-credential.test.ts:654-660`), the test `"six concurrent mints with room for one produce exactly one registrar"` **passes even when the advisory lock is removed**, because the local edge runtime processes those requests serially.
* The other server tests (`quota limits`, `expiry exclusion`, `audit reason logging`, `trigger immutability`) and the CLI AST test have tight negative controls and fail when their respective properties are mutated (as verified by the lead's six mutation runs).

---

#### 7. Commit message claims vs. diff
The commit message does not claim anything the diff does not do.
* Live credential limits (5/user, 20/workspace) and 403 error shape: matches lines 709–711 and 5542–5569.
* Single shared helper with advisory lock and expiry-aware count: matches lines 5427–5451.
* Wiring both ceiling checks through the helper: matches lines 5541 and 6913.
* Trigger refusing seat consumption on expiry: matches migration lines 89–90.
* Audit differentiation (`not_permitted` vs `not_found`): matches lines 5765–5768.
* Test suite additions and mutations: accurately reflected in both test files.

---

VERDICT: PASS
The three confirmed production defects are cleanly resolved with safe database locks, precise expiry filtering, tight quota caps, and matching controls.
