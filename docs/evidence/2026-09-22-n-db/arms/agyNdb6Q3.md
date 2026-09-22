### Part Q3: Activity Publish Grant Review

#### Scope & Files Evaluated
- `deploy/supabase-stack/migrate/ACTIVITY-PUBLISH.md`
- `deploy/supabase-stack/migrate/activity-publish-grants.sql`
- `deploy/supabase-stack/migrate/activity-publish-grants.isolated-setup.sql`
- `deploy/supabase-stack/migrate/activity-publish-grants.isolated-assert.sql`
- `deploy/supabase-stack/migrate/activity-publish-grants.test.sh`

---

### 1. Activity Publish Grant Analysis (Question 3)

#### Privilege Scope: Write & Read Confinement
- **Schema & Table Grants**:
  - `commonswarm_edge` receives `USAGE` on schema `realtime`.
  - `commonswarm_edge` receives column-scoped `INSERT` strictly on `(id, payload, event, topic, private, extension)` of `realtime.messages`.
  - Table-level `INSERT` is withheld; `SELECT`, `UPDATE`, `DELETE`, and `TRUNCATE` are withheld.
  - Column `inserted_at` is withheld (the database default `now()` governs insertion).
- **Role Isolation & Inheritance**:
  - `swarm_command` receives no schema `USAGE` and no table/column `INSERT` privileges.
  - While `commonswarm_edge` inherits from `swarm_command` (`GRANT swarm_command TO commonswarm_edge`), PostgreSQL privilege inheritance is unidirectional: `swarm_command` inherits no privileges from `commonswarm_edge`.
  - Client roles (`anon`, `authenticated`, `service_role`) and `PUBLIC` receive no additional grants.
- **Read Operations**:
  - `commonswarm_edge` cannot read `realtime.messages`. No `SELECT` privilege is granted, and no `SELECT` policy is added.
  - Existing member `SELECT` policies (`agent receives its own wake`, `workspace members receive agent activity`, `workspace members receive signals`) remain untouched.

#### Row Security Enforcement
- **Enforcement Mechanics**:
  - Table `realtime.messages` has `relrowsecurity = true`.
  - Roles `commonswarm_edge` and `swarm_command` both have `rolbypassrls = false` and `rolsuper = false`.
  - As a result, PostgreSQL strictly enforces `WITH CHECK` clauses on any `INSERT` executed by `commonswarm_edge`.
- **Policy Scoping (`commonswarm_edge_activity_insert`)**:
  - `extension = 'broadcast'`
  - `private IS TRUE` (rejects `false` and `NULL`)
  - `event = 'activity'` (rejects `wakeup`, `signals`, etc.)
  - `topic ~ '^cswarm-activity:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'` (anchored, canonical lower-case UUID format; rejects uppercase, non-UUIDs, or mismatched topic prefixes).
- **Function Execution Boundary (`realtime.send`)**:
  - `realtime.send` is `SECURITY INVOKER`. When called by `commonswarm_edge`, the function executes under `commonswarm_edge`'s credentials and is subject to the column-privilege and RLS constraints.
  - Because `realtime.send` catches exceptions internally (`WarnSendingBroadcastMessage`), an invalid call does not throw at the function level, but the RLS `WITH CHECK` rejects the row insertion. The row is never written to `realtime.messages`.

---

### 2. Test Integrity & Failure Fidelity (Question 5)

Each test in `activity-publish-grants.test.sh` and `activity-publish-grants.isolated-assert.sql` executes against an isolated unix-socket PostgreSQL cluster and fails for its claimed reason:

1. **Banned Pattern Check** (`activity-publish-grants.test.sh:58-71`):
   - Fails if `SECURITY DEFINER`, `BYPASSRLS`, table-level `GRANT INSERT ON`, `SELECT`/`UPDATE`/`DELETE`/`TRUNCATE` grants, `TO public/anon/authenticated`, or `ALTER/SET ROLE` are introduced into `activity-publish-grants.sql`.
2. **Precondition Fail-Close Check** (`activity-publish-grants.test.sh:110-132`):
   - Executes `activity-publish-grants.sql` on a database where `commonswarm_edge` is missing; fails unless PostgreSQL aborts with SQLSTATE `42704` and error message `commonswarm_edge role does not exist`.
3. **Pre-Grant Rejection Check** (`activity-publish-grants.test.sh:136-159`):
   - Verifies that before the migration runs, `commonswarm_edge` cannot insert into `realtime.messages`, failing if pre-existing permissions allow the insert or return an unexpected SQLSTATE.
4. **Migration Idempotency Check** (`activity-publish-grants.test.sh:161-162`):
   - Applies `activity-publish-grants.sql` twice consecutively; fails if policy recreation (`DROP POLICY IF EXISTS`) or grants conflict on re-execution.
5. **Environment Isolation Guards** (`activity-publish-grants.isolated-assert.sql:4-21`):
   - Guards fail-close if run against `172.31.0.10`, a target marked `n-db-target-v1`, or a database containing schema `swarm` or role `supabase_realtime_admin`.
6. **Negative RLS & Permission Assertions** (`activity-publish-grants.isolated-assert.sql:152-246`):
   - 13 distinct statements tested through `expect_denied_as(role, stmt, '42501')`. Each fails if execution succeeds or yields any error code other than `42501` (`insufficient_privilege`), covering invalid events, public broadcasts, non-activity topic prefixes, uppercase UUIDs, malformed UUIDs, presence extensions, extra column `inserted_at`, direct `SELECT`/`UPDATE`/`DELETE`/`TRUNCATE`, and attempts by `swarm_command` to insert or call `realtime.send`.
7. **Positive Execution & Void Suppression Check** (`activity-publish-grants.isolated-assert.sql:248-300`):
   - Verifies that valid activity rows are stored on both direct insert and `realtime.send`, while calls to `realtime.send` with invalid event/private/topic shapes do not store rows despite returning `void` without throwing.

---

### 3. Documentation vs. Code Consistency

- `ACTIVITY-PUBLISH.md` accurately describes the operational model:
  - Explains why schema `USAGE` alone was insufficient (realtime function catches insert failures as warnings, returning 202 without persisting the message).
  - Outlines the authorization boundary in the Edge Functions activity handler (`SET LOCAL ROLE swarm_command`, validate, `RESET ROLE`, call `realtime.send`).
  - Documents the least-privilege matrix, idempotency rules, and migration execution sequence.
  - The production verification queries in `ACTIVITY-PUBLISH.md` (checking schema usage, exact column array equality `['event','extension','id','payload','private','topic']`, policy attributes, and membership) match the catalog schema.

---

### 4. Findings

#### RIGOUR: Pre-flight check in migration does not assert `relrowsecurity` on target table
- **File & Line**: `deploy/supabase-stack/migrate/activity-publish-grants.sql:26-59`
- **Sequence**: The pre-flight `DO $do$` block validates that `commonswarm_edge` exists (`42704`), `realtime.messages` exists (`42P01`), and that the six expected columns exist with correct types. It does not check `pg_class.relrowsecurity` for `realtime.messages`.
- **Impact**: While Supabase Realtime natively provisions `realtime.messages` with RLS enabled, and `activity-publish-grants.isolated-assert.sql:102-112` strictly asserts `relrowsecurity = true`, if `activity-publish-grants.sql` were ever applied to a database where RLS was toggled off, `CREATE POLICY` would succeed but the policy would not be enforced until RLS was enabled.
- **Classification**: **RIGOUR** (Non-blocking for production because `realtime.messages` has RLS enabled on the Hetzner target and source, and the verification gate in `ACTIVITY-PUBLISH.md` requires catalog validation).

---

### 5. Dependencies External to Part Q3

The following external dependencies are required by the migration and test suite but are not defined within this diff:
1. `deploy/supabase-stack/migrate/prepare-target.sh`: Checked by `activity-publish-grants.test.sh:37,54` to ensure it invokes `activity-publish-grants.sql`.
2. `deploy/supabase-stack/migrate/lib.sh`: Sourced by migration wrappers for database connection helpers and identity assertions (`assert_source_identity`, `assert_target_identity`).
3. Edge Function Activity Handler: Implements the workspace/session authentication boundary before calling `realtime.send`.
4. Upstream `realtime.messages` schema and SELECT policies: Standard Supabase Realtime schema definitions present on the production box.

---

VERDICT: PASS (the activity publish grant enforces least privilege, holds strictly under row security without widening read or write boundaries, and tests accurately verify all positive and negative constraints)
