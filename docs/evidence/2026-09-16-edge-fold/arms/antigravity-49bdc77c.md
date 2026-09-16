### 1. Semantics

* **`set_config('role', X, true)` vs. `SET LOCAL ROLE X`:**
  * **Mechanics & Membership Check:** In PostgreSQL 17, `SET ROLE X` and `SET LOCAL ROLE X` internally set the GUC parameter `"role"`. Both `SET LOCAL ROLE X` and `SELECT set_config('role', 'X', true)` invoke the GUC check hook `check_role`. `check_role` resolves the role OID and invokes `has_privs_of_role(GetSessionUserId(), roleid)`. If the session user is not a member of role `X` (and not a superuser), both throw the identical error: `ERROR: permission denied to set role "X"`.
  * **`assign_role`, `current_user`, and RLS:** When the GUC assign hook `assign_role` executes, it calls `SetCurrentRoleId(roleid, is_superuser)`. The SQL function `current_user` evaluates `GetCurrentUserId()`, returning `X` in both cases. Row-Level Security (RLS) policies evaluate against `current_user` and the active role set; their enforcement is identical.
  * **SECURITY DEFINER Calls:** PostgreSQL maintains a user/security context stack (`SetUserIdAndContext`). Calling a `SECURITY DEFINER` function switches the context to the function owner for the function execution duration and restores the prior user ID (`X`) on return, regardless of whether `X` was established via `SET ROLE` or `set_config('role', ...)`.
  * **`RESET ROLE`:** In PostgreSQL, `RESET ROLE` resets the `"role"` GUC to `none` (the session user ID). If invoked inside a transaction, it restores the session identity in both cases.
  * **`statement_timestamp()`:** In PostgreSQL, `statement_timestamp()` returns the start time of the current statement. In `SELECT set_config('role', ...), set_config('search_path', ...), set_config('lock_timeout', ...)`, `statement_timestamp()` is the start time of that composite `SELECT`. Subsequent statements have their own distinct `statement_timestamp()` values.
  * **Identifier casing / syntax:** In `command`, `capability`, and `read`, the roles (`swarm_command`, `swarm_capability`, `swarm_read`) are lowercase unquoted identifiers. `SET LOCAL ROLE swarm_command` folds to lowercase `'swarm_command'`; `set_config('role', 'swarm_command', true)` passes the literal `'swarm_command'`. They resolve identically.
* **`set_config('lock_timeout', '5s', true)`:**
  * `lock_timeout` is a GUC variable (`PGC_USERSET`). Setting it via `set_config(..., true)` sets the transaction-local timeout identically to `SET LOCAL lock_timeout = '5s'`.
* **`postgres.js` 3.4.9 `db.begin("isolation level read committed", ...)`:**
  * In `postgres.js` 3.4.9, passing a string option as the first argument to `db.begin(options, fn)` prepends `begin `: it sends `begin isolation level read committed` over the wire.
  * In PostgreSQL 17, `BEGIN ISOLATION LEVEL READ COMMITTED` is valid standard SQL syntax.
  * If the transaction callback rejects or throws, `postgres.js` catches the rejection in its transaction runner, issues `ROLLBACK`, and re-throws the error to the caller.
* **Scope Across Savepoints, Nested Begins, and Port 6543:**
  * **Transaction-local scope (`is_local = true`):** Changes made with `is_local = true` remain active for the duration of the transaction.
  * **Savepoints / nested begins:** In `postgres.js`, a nested `tx.begin(...)` creates a `SAVEPOINT`. Reverting a savepoint (`ROLLBACK TO SAVEPOINT`) only rolls back GUC changes made *after* that savepoint was established. The outer transaction-level settings remain in effect.
  * **Port 6543 transaction pooler (Supavisor / PgBouncer in transaction mode):** The pooler pins the server connection from the receipt of `BEGIN` until `COMMIT` or `ROLLBACK`. All statements inside `tx` run on that same connection. When the transaction finishes, PostgreSQL transaction cleanup reverts all `LOCAL` GUCs to session defaults before the connection is returned to the pool, preventing GUC leakage.

---

### 2. Pipelining

* **Pipelining via `Promise.all` on `TransactionSql`:**
  * In `postgres.js` 3.4.9, `tx` is bound to the single reserved connection for that transaction.
  * When `Promise.all([ tx`...`, tx`...`, tx`...` ])` is called, all three tagged template functions execute synchronously in the event loop turn. `postgres.js` serializes each query and writes them sequentially into the socket output buffer without awaiting individual responses (extended query protocol pipelining).
  * All three queries run on the transaction's reserved connection within the active `BEGIN ... COMMIT` block.
* **Failure Handling:**
  * If any query in the pipeline fails (e.g., query 2 fails), PostgreSQL aborts the transaction (`ERROR: current transaction is aborted, commands ignored until end of transaction block`). Subsequent pipelined queries in the batch fail with this abort error.
  * The promise for the failing query rejects. `Promise.all` immediately rejects with that initial error, which throws inside `db.begin(...)`.
  * `db.begin` catches the exception, executes `ROLLBACK`, and re-throws the error.
  * The handler returns the exact same HTTP 500 error status and payload as it did when statements were executed sequentially.
  * Because `Promise.all` attaches rejection handlers to all input promises upon call, subsequent query rejections do not trigger `unhandledRejection` warnings.
* **Result Ordering:**
  * `Promise.all` preserves positional index ordering in the resolved array (`[members, agents, workspaceRows]`).
  * On the wire, PostgreSQL processes pipelined queries in strict FIFO order, and `postgres.js` resolves the corresponding promises in the exact order of received completion messages.

---

### 3. Coverage & Statement Counts

* **Request-Path Transaction Setup Coverage:**
  * `supabase/functions/read/index.ts`: `db.begin("isolation level read committed", ...)` + `setReadTransaction` (1 statement) + later combined JWT claims & `search_path` (1 statement).
  * `supabase/functions/command/index.ts`: Both `handleTransaction` and `resolveLedgerRace` use `db.begin("isolation level read committed", ...)` + `setTransaction` (1 statement). The detached `drainFilePurgeQueue` is asynchronous background work (not on the request path) and folds its two setup statements into one `SELECT set_config(...)`.
  * `supabase/functions/capability/index.ts`: `db.begin("isolation level read committed", ...)` + `setTransaction` (1 statement).
  * `supabase/functions/activity/index.ts`: `db.begin("isolation level read committed", ...)` + inline folded `SELECT set_config(...)` (1 statement).
* **Sequential Statements on the Check Path (`cswarm check`):**
  The `cswarm check` path consists of three HTTP requests to the edge: (1) credential verification / whoami, (2) directory read (`resource: "members"`), and (3) inbox page (`resource: "signals"`).
  * In `read/index.ts`, the sequence within the transaction has genuine data dependencies:
    1. Session setup (`setReadTransaction`) sets role `swarm_read` and search path `swarm_read, swarm, pg_catalog`.
    2. Definer call authenticates `tokenHash` and returns the agent record (`agent.owner_user_id`, `agent.principal_id`).
    3. Setting `request.jwt.claims` requires `agent.owner_user_id` and `agent.principal_id`, which are not known until step 2 completes.
    4. The resource queries require `request.jwt.claims` to be installed for RLS policies.
    Thus, step 1, step 2, step 3, and step 4 cannot be pipelined together.
* **Statement Counts & Round Trips (RTT) per Request:**

| Request on Check Path | SQL Statements (Before) | SQL Statements (After) | Round Trips (Before) | Round Trips (After) | Latency @ 110ms RTT (Before) | Latency @ 110ms RTT (After) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Directory (`resource: "members"`)** | 12 | 8 | 12 | 6 | ~1,320 ms | ~660 ms |
| **Credential / Whoami Read** | 10 | 6 | 10 | 6 | ~1,100 ms | ~660 ms |
| **Inbox Page (`resource: "signals"`)** | 10 | 6 | 10 | 6 | ~1,100 ms | ~660 ms |
| **Total `cswarm check` Operation** | **32** | **20** | **32** | **18** | **~3,520 ms** | **~1,980 ms** |

*Breakdown for Directory (`members`):*
* **Before (12 RTTs):** `BEGIN` (1) $\rightarrow$ `SET TRANSACTION` (2) $\rightarrow$ `SET LOCAL ROLE` (3) $\rightarrow$ `SET LOCAL search_path` (4) $\rightarrow$ `SET LOCAL lock_timeout` (5) $\rightarrow$ Definer authenticate (6) $\rightarrow$ `set_config(request.jwt.claims)` (7) $\rightarrow$ `SET LOCAL search_path` (8) $\rightarrow$ `member_profiles` (9) $\rightarrow$ `agent_principals` (10) $\rightarrow$ `workspaces` (11) $\rightarrow$ `COMMIT` (12).
* **After (6 RTTs):** `BEGIN isolation level read committed` (1) $\rightarrow$ `SELECT set_config('role'...), set_config('search_path'...), set_config('lock_timeout'...)` (2) $\rightarrow$ Definer authenticate (3) $\rightarrow$ `SELECT set_config('request.jwt.claims'...), set_config('search_path'...)` (4) $\rightarrow$ Pipelined `Promise.all([members, agents, workspaceRows])` (5) $\rightarrow$ `COMMIT` (6).

*Result:* Total operation latency drops from ~3,520 ms (which caused 5/5 timeouts against the 3.0 s budget) to ~1,980 ms, well under the 3.0 s budget.

---

### 4. Tests & Citations

* **Citation Drift (`tests/p1-cli/citation-drift.test.ts`):**
  * Hunk 1 of `supabase/functions/command/index.ts` (lines 1483–1492) replaced 4 lines of `unsafe` calls with a 6-line template literal (+2 net lines).
  * Every downstream line cited in `command/index.ts` shifted by exactly +2 lines:
    * `site/src/lib/agent-connect.ts`: 2688–2691 $\rightarrow$ 2690–2693; 3218–3228 $\rightarrow$ 3220–3230; 9225–9231 $\rightarrow$ 9227–9233.
    * `agent-connect-mint.observer.test.ts`: 2445–2447 $\rightarrow$ 2447–2449; 2452 $\rightarrow$ 2454; 2506 $\rightarrow$ 2508; 4608 $\rightarrow$ 4610.
    * `command/index.ts` self-citation: 3659 $\rightarrow$ 3661.
  * All 8 citations point directly to their target code definitions.
* **Diagnostic Mutation Controls (`tests/read-edge-diagnostics.test.ts`):**
  * `read BEGIN options removed`: Mutation removes isolation level from `read/index.ts`. `assertRoundTripFold` expects match count 1, gets 0 $\rightarrow$ throws as expected.
  * `read role setting removed`: Mutation removes `set_config('role', 'swarm_read', true)`. Regex match in `assertRoundTripFold` fails $\rightarrow$ throws as expected.
  * `member reads serialized`: Mutation replaces `Promise.all` with `Promise.resolve`. Regex match fails $\rightarrow$ throws as expected.
  * `command BEGIN options removed`: `commandSource.replace(...)` replaces the first occurrence of `db.begin("isolation level...", ...)`. `assertRoundTripFold` expects match count 2, gets 1 $\rightarrow$ throws as expected.
  * `command search path removed`: Mutation removes `set_config('search_path', 'swarm, pg_catalog', true)`. Regex match fails $\rightarrow$ throws as expected.
  * `every edge function folds its transaction setup`: For `activity` and `capability`, swapping `set_config('role', ...)` back to `tx.unsafe("SET LOCAL ROLE ...")` trips `/unsafe\(\s*"SET (TRANSACTION|LOCAL ROLE|LOCAL lock_timeout)/` in `assertNoUnfoldedSetup` $\rightarrow$ throws as expected.

---

### Findings

#### [RIGOUR] `tests/read-edge-diagnostics.test.ts:333`
* **File & Line:** `tests/read-edge-diagnostics.test.ts:333`
* **Concrete Sequence:**
  `const bareBegins = [...source.matchAll(/db\.begin\(async \((\w+)\) => \{\s*await \1(\.unsafe\(|`\s*SELECT\s+set_config\('role')/g)].length;`
  This regex assumes that an unfolded transaction immediately executes `await <txParam>.unsafe(...)` or `await <txParam>`SELECT set_config('role'...`. If a handler opens a bare transaction and delegates setup to an intermediary function (e.g. `await db.begin(async (tx) => { await setTransaction(tx); })`), the regex capture `\1` does not match `setTransaction`, evaluating `bareBegins` to 0.
* **Impact on Client or Operator:**
  No production impact. In this test suite, `read` and `command` are validated by `assertRoundTripFold` (asserting exact counts of 1 and 2 `db.begin("isolation level...", ...)`), and `activity` and `capability` are explicitly asserted at line 343 (`assert.equal([...source.matchAll(/db\.begin\("isolation level read committed", async \(tx\) =>/g)].length, 1)`). The edge functions are fully constrained by the surrounding assertions.

---

VERDICT: PASS
The fold preserves PostgreSQL 17 transaction semantics and RLS, safely pipelines read queries under READ COMMITTED without snapshot anomalies, reduces check-path round trips from 32 to 18 (cutting latency from ~3.5s to ~2.0s against the 3.0s budget), and updates citation drift tracking accurately.
