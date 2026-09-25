I'll review the renewal last-use lane as a read-only check against the five criteria, starting from the lane record and the diff from `5d603b8e` to `e1cfd84c`.The lane is two commits on top of `5d603b8e`. Next I’ll compare each replaced function with its latest prior definition and check every writer of `last_used_at`.The function bodies differ by one assignment each, and the catalog digests match those bodies. Next I’ll check the installed catalog and the proof inside a transaction that rolls back.The lock query failed after the old function bodies were installed in that transaction. I'll confirm the session abort restored the fixed bodies.The monotonic last-use change is sound. No findings.

Checked `git diff 5d603b8e..e1cfd84c` (commits `94f08252` and `e1cfd84c`) against the September 4 definitions and the local PostgreSQL 17.6 catalog. The catalog proof was run inside transactions that were rolled back. After a stack recreate during this review, `20260925000002` was not recorded; applying the migration text in a transaction made the proof return `t`, and the rollback left the September 4 recorder body in place (`md5` `2132710e…`).

**1. Writers, signature, and the other columns.** The latest prior definitions are in `supabase/migrations/20260904000001_standing_grant_resume.sql`. A line diff of each `CREATE OR REPLACE` against `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql` shows one changed line per function:

```344:345:supabase/migrations/20260904000001_standing_grant_resume.sql
  UPDATE swarm.renewal_grants AS grant_row
  SET last_used_at = statement_timestamp(),
```

```16:17:supabase/migrations/20260925000002_renewal_last_use_monotonic.sql
  UPDATE swarm.renewal_grants AS grant_row
  SET last_used_at = GREATEST(grant_row.last_used_at, statement_timestamp()),
```

```509:511:supabase/migrations/20260904000001_standing_grant_resume.sql
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1,
      last_used_at = statement_timestamp(),
```

```181:183:supabase/migrations/20260925000002_renewal_last_use_monotonic.sql
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1,
      last_used_at = GREATEST(last_used_at, statement_timestamp()),
```

Headers, `SECURITY DEFINER`, `search_path`, owner, `REVOKE`/`GRANT`, and the fence comment match. The recorder privileges are the same block at `20260904000001` lines 366–370 and `20260925000002` lines 38–42. With the migration applied, the catalog showed `prosecdef = t`, `proconfig = {search_path=swarm, pg_catalog}`, owner `swarm_admin`, and ACL execute for `swarm_admin`, `swarm_command`, and `swarm_read` only. The fence stayed non-definer, `search_path=pg_catalog`, owner `swarm_admin`, ACL owner-only.

`last_used_at\s*=` in `supabase/migrations` and `supabase/functions` hits only these two live assignments. The September 1 copies are superseded. The catalog agrees: only `swarm.record_renewal_grant_use(uuid,uuid,text)` and `swarm.agent_tokens_successor_fence()` contain that assignment. The edges call the recorder and pass `NULL` for the source text:

```534:539:supabase/functions/read/index.ts
    await tx`
      SELECT swarm.record_renewal_grant_use(
        ${agent.token_id}::uuid,
        ${agent.device_id}::uuid,
        NULL
      )
```

```10929:10935:supabase/functions/command/index.ts
      await tx`
        SELECT swarm.record_renewal_grant_use(
          ${auth.agent.token_id}::uuid,
          ${auth.agent.device_id}::uuid,
          NULL
        )
      `;
```

`device_id` comes from the token’s run. Overlapping reads by one seat write the same device and `COALESCE(NULL, existing)` for `last_used_from`. The `new_host_at` CASE is unchanged (`20260925000002` lines 20–29 and 185–191): a non-null value is kept, so the blocked statement does not store its older `statement_timestamp()` over the later use. On a first use, `GREATEST(NULL, statement_timestamp())` is the timestamp (confirmed on this server), which matches the old assignment.

The trigger function is not in the new migration. Its installed body matched the September 4 source (`md5` `746f6d2dd801d4666854f3c33f2bd191`), still enabled (`tgenabled = O`).

**2. `GREATEST` under READ COMMITTED.** Both edges open `isolation level read committed` (`supabase/functions/read/index.ts` line 445, `supabase/functions/command/index.ts` lines 8902 and 11061). After a lock wait, PostgreSQL rechecks the updated row and runs the `SET` list against that version, which is why `successors_used = successors_used + 1` already sees the committed counter. `GREATEST(grant_row.last_used_at, statement_timestamp())` therefore sees the later committed `last_used_at` and keeps it, because `statement_timestamp()` stays at the blocked statement’s start. The lead’s passing test is that path. The trigger’s other guarded columns are not given an older value: this update list is only `last_used_at`, `last_used_device_id`, `last_used_from`, and `new_host_at`, and the fence increments `successors_used` from the row it already holds with `FOR UPDATE` (`20260925000002` lines 139–142, then 181–192). A same-seat replay does not change device or source text, so `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` (`20260904000001` lines 170–176) stays quiet, and an existing `new_host_at` stays put under lines 177–181.

**3. The test reproduces the race.** In `tests/p1-server/renewal-last-use.test.ts`, B locks the grant (lines 102–105), A starts `record_renewal_grant_use` (lines 108–111), and the test requires A’s backend to show `wait_event_type = 'Lock'` before B records use (lines 114–126). B’s use is a later statement, then B commits. A must succeed and the stored time must equal B’s (lines 132–137). The old assignment writes A’s earlier `statement_timestamp()`. The trigger then raises `SWARM_RENEWAL_LAST_USE_REWOUND` with `55000`:

```165:168:supabase/migrations/20260904000001_standing_grant_resume.sql
  IF OLD.last_used_at IS NOT NULL
     AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'SWARM_RENEWAL_LAST_USE_REWOUND' USING ERRCODE = '55000';
```

The served half is the membership call, not a side path. It waits until some backend is blocked in `SELECT swarm.record_renewal_grant_use(` (test lines 179–189), which is the statement after `setPhase("membership")` (`read/index.ts` lines 499 and 534–540). A trigger error falls through `.catch` at line 965 to `readFailureResponse`, which returns HTTP 500 (lines 383–390). HTTP 200 means that statement committed, and the test also requires B’s timestamp to remain. `npm run test:p1-server` passes `tests/p1-server/**/*.test.ts` to Node (`package.json` line 29); this file is one of the 16 top-level files that pattern includes.

**4. Catalog proof.** `deploy/release-proofs/renewal-last-use/catalog.sql` lines 6 and 18 require `md5(prosrc)` `ad14bdf0f3934d6b05bc5ef261e49a20` and `8df3387da81f79881a9508d0d0ba6b2d`. Those are the migration bodies as PostgreSQL stores `prosrc`. The September 4 bodies hash to `2132710ef18f9f38d8d79aab0e1af626` and `6015d9704140a4b4e97dab7437ab3f7c`. On the applied catalog the proof returned `t`. After installing the September 4 bodies in that transaction it returned `f`. On the recreated stack the old bodies returned `f`, and the same migration statements returned `t` before rollback.

**5. Apply on the box.** The file is `CREATE OR REPLACE` of the same signatures, plus owner, grant, and comment statements. It takes no lock on `swarm.renewal_grants`. It holds `AccessExclusiveLock` on the two function objects until the migration transaction ends, and `ShareUpdateExclusiveLock` on the fence from the comment. A call to `record_renewal_grant_use` holds `RowExclusiveLock` on `swarm.renewal_grants` and no object lock on the function, so this DDL does not wait on in-flight reads and in-flight reads do not wait on it. `CREATE OR REPLACE` keeps the same function OID; a call already inside the old body finishes that body, and the next call sees the new one after commit. `REVOKE` names `PUBLIC`, `anon`, and `authenticated` only, so `swarm_command` and `swarm_read` keep execute across the transaction.

VERDICT: PASS
