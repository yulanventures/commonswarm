# D-036 Checker review, round 3 (Claude Opus arm): H0 lane 5a at f1ba1fb3

Scope: `git diff a103a512...f1ba1fb3` and `git diff 3dc812c9...f1ba1fb3` (13 files in fold 3), LANE.md "Fold 3",
the round-2 reviews (codex-r2.md FAIL, opus-r2.md PASS), and the helpers that the fold calls (`lib.sh`
`cron_jobs_json_sql` / `compare_cron_job_listings`, `restore-cron-jobs.sh`, `verify-h0-catalog.sql`). I used only
read-only git commands and local hashing (`git show f1ba1fb3:<file> | shasum -a 256`). I ran no test, no database,
no Docker, and no network command.

## Fold-3 claims, checked on the code

1. **The FOR UPDATE on the seat lock row: holds.** `poll-ack.ts:759-765` runs `SELECT holder ... FOR UPDATE` first.
   The clock query at `:767-789` runs after it, so a slice that blocked on the row uses a `clock_timestamp()` read
   after it got the lock. `collect` runs in the same transaction (`:940-948`), so the row stays locked through the
   read or claim. A takeover (`acquireLock`, `:647-668`, `INSERT ... ON CONFLICT DO UPDATE ... WHERE
   poll_lock.expires_at <= statement_timestamp()`) must wait for that row lock, and then re-checks the WHERE on the
   committed row. The residual window is in R1.
2. **The transaction is not held across the 1 s sleep: holds.** The slice transaction is the callback of
   `h0Database().begin` (`:892-950`). `await sleep(pause, request.signal)` is at `:955`, after `begin` returns. No
   pool connection is checked out during the sleep.
3. **No deadlock: holds.** Lock order, per path:
   - first transaction: seat lock row R (`acquireLock`), then batch rows and `signal_deliveries` rows (`collect`);
   - slice: R (`FOR UPDATE`), then the same `collect` order;
   - `claimWaitingSlot` / `releaseLock`: deployment advisory lock, then R (`:674-731`);
   - `ackBatch`: inside `collect`, after R;
   - ack (`handleH0AckRequest` → `ackAgentDelivery`) and the command-edge ack: `signal_deliveries` only. They
     never touch R, the batch table, or the advisory lock (`grep h0_poll_ poll-ack.ts` shows no use after `:798`).
   No path takes R and then waits for the advisory lock. So no cycle exists. A `releaseLock` can wait on R while it
   holds the advisory lock only after a takeover, while the new holder's slice holds R. Admission then waits for
   one short transaction. That is a brief convoy, not a deadlock.
4. **204 on client abort: holds, and it leaves no wrong state.** `h0/index.ts:44`: `if (error instanceof
   H0ClientAbort) return new Response(null, { status: 204 });`. It is a class check, so D-053 is clean.
   `H0ClientAbort` can come only from `throwIfAborted` (`:879`, `:891`) or `sleep` (`:955`). All three are inside
   `current.kind === "empty"`, so no batch was built in that request. The `finally` at `:971-979` runs
   `releaseLock` before the rejection reaches `.catch`. That sets `waiting = false, expires_at = now` for this
   holder, so the slot and the seat lock are free at once. An abort during a started slice transaction does not
   stop that transaction. If it claimed rows, `current` is `"ready"`, the 200 goes to a closed socket, and the next
   poll replays the active batch.
5. **Pinned hashes: hold.** Local `shasum -a 256` of the five files at f1ba1fb3 gives `e3271bd3…`, `fbd0a9bd…`,
   `beb6bf0f…`, `3d57cf0a…`, `ba059d9d…`. These match `sha1`..`sha5` in `apply-h0-upgrade.sh:27-32`. The five
   `prosrc` SHA-256 values in `verify-h0-poll-catalog.sql:305-315` (`b7bf808f…`, `1130f232…`, `dfa6c6be…`,
   `3cde2f3a…`, `0f963ce2…`) match the `$$` bodies of `h0_poll_locks_guard` (000001) and the four 000003 functions.
   The 000001 batch guard body (`dbfaed0d…`) is correctly absent, because 000003 replaces it.
6. **000003 is applied on both apply branches, and the verifier runs on all three branches: holds**
   (`apply-h0-upgrade.sh:97-100`, `:84-85`, `:103`). `run-db-tool.sh` mounts the fifth file. The fold also removes
   the `swarm.config` INSERT. `h0_poll_batch_retention_days()` returns the floor 2 when the key is absent
   (000003 `:31-36`). So the migration no longer changes the `swarm.config` row count that the post-upgrade count
   check keeps unchanged. Removing `CREATE EXTENSION pg_cron` is safe, because `p1_schema:837` already creates it.
7. **Closed-at index: holds.** `h0_poll_batches_closed_at (closed_at, workspace_id, principal_id, batch_id) WHERE
   status = 'closed'` matches the purge's `WHERE status = 'closed' ... ORDER BY closed_at, workspace_id,
   principal_id, batch_id`.
8. **The abort test passes only local settings: holds.** `h0-poll-ack.test.ts` (child `env`) now sets `PATH`,
   `HOME`, optional `DENO_DIR`, `SWARM_DATABASE_URL: local.DB_URL`, `SUPABASE_DB_URL: local.DB_URL`, and the test
   tokens. The child inherits no exported URL and no `SWARM_DATABASE_TLS_CA_B64`. Round-2 F5 is closed.
9. **The batch guard test uses SQLSTATE: holds.** `batchImmutable` is now `error.code === "55000"`. It reads no
   message text.
10. **The 000001 header is restored: holds.** The comment block is whole again. The index statement follows it.
11. **LANE.md records that box abort propagation is not established: holds.** "Fold 3" states the exact
    `worker.fetch(forwarded)` question. Round-2 F1 is now recorded in the artifact.
12. **The stalled-slice test can fail for the stated reason: holds.** The test waits for `waiting = true`, then
    holds R with `FOR UPDATE` on another connection. It posts an ask, waits 1.5 s, and asserts that the first poll
    has not settled. Without the slice's `FOR UPDATE`, a plain `SELECT` would not block. The next slice would see
    the committed, unexpired row and claim the new delivery, so `firstSettled` would become true and the assertion
    would fail. With it, the blocked slice reads `expires_at` in the past after the test commits. It gets
    `unexpired = false` (checked before `within_wait`, `:791`) and returns 409 `h0_poll_lock_ended`. The next poll
    returns the delivery, whichever of the two gets R first. The file is reached by the `test:p1-server` glob. I did
    not run the lead's mutation control. See R3.
13. **Join-present / poll-absent branch and poll-catalog mutations are tested: holds as written.**
    `test-h0-upgrade.py` sets up the join pair only and applies. It then runs seven poll mutations (column, active
    index, guard disabled, guard body, grant, purge function, cron row), each on the skip branch, each required to
    be rejected. The earlier "present verify skip" is the positive control. `test-post-upgrade-counts.py` adds
    missing-purge and duplicate-purge negatives. Both files are reached by `test:h0-upgrade:local` and
    `test:h0-counts`.
14. **Fence unchanged.** Fold 3 does not touch `supabase/functions/command/` or the three listener clients. The
    round-1 and round-2 fence analysis still applies.

## Findings

### P1: PRODUCTION. The post-upgrade count check always adds the purge job, so the documented restore of a post-H0 snapshot fails.
`deploy/supabase-stack/migrate/verify-post-upgrade-counts.sh:21-31`:
```
cp "$MIGRATION_ARTIFACT_DIR/cron-jobs.ndjson" "$derived/cron-jobs.ndjson"
target_psql --quiet --tuples-only --no-align -c "
  SELECT json_build_object(
    'jobname', 'swarm-purge-h0-poll-batches', ...
" >>"$derived/cron-jobs.ndjson" 2>>"$LOG_FILE"
```
The purge job is added to the expected listing with no condition. The table logic in the same file adds the poll
pair only when the baseline lacks it (`:59-65`, `if (!c) { expected["swarm.h0_poll_locks"]=0 ... }`). It "retains a
pair's original counts when a recovery snapshot already contained that pair" (RUNBOOK.md:80). RUNBOOK.md:82 says:
"Recovery snapshots taken after H0 therefore follow the same sequence: baseline verification, catalog
verification/skip, post-upgrade counts, then edge startup."

For a snapshot taken after this lane is deployed, the snapshot's `cron-jobs.ndjson` already holds
`swarm-purge-h0-poll-batches`. `restore-cron-jobs.sh` schedules it again as its recorded user (`:47-48`). The skip
branch of `apply-h0-upgrade.sh` accepts it, because `verify-h0-poll-catalog.sql:326-331` requires exactly one. Then
the expected listing holds the purge record twice, and the target holds it once.
`compare_cron_job_listings` (`lib.sh:229-290`) compares a multiset with counts. It prints "cron job counts differ:
expected N+1, actual N" and exits 1. The runbook forbids the workaround: "do not retry by deleting tables or editing
checksums." Before the fold, the cron listing was compared unchanged, and this path passed.

The effect fails closed: no data is lost. But an operator who restores the box from its own post-H0 backup is
stopped at the last check before edge startup, and no documented step gets past it. `test-post-upgrade-counts.py`
has no case where the baseline already has the purge job (`self.baseline` cron is `{"jobname":"test"}` only), so
the gates cannot see this.

Fix: add the purge record only when the baseline `cron-jobs.ndjson` has no `swarm-purge-h0-poll-batches` record.
This mirrors the table-pair rule. Add a counts test whose baseline and target both have the job once, and require
it to pass. Keep the duplicate-job negative.

### R1: RIGOUR. A slice that stalls after its hold check can still return a batch after its lock expires. The test name claims more than the test shows.
`poll-ack.ts:918-948`: the hold is checked once (`readWaitHold`), then `collect` runs. `expires_at` is
`acquired_at + wait + 6 s` (`parse.ts:96-97`), and `within_wait` gates `collect`, so the margin is at least 6 s.
If the slice transaction stalls for more than about 6 s inside `collect`, a poll B that starts after `expires_at`
waits on R. When A commits, B's `ON CONFLICT ... WHERE poll_lock.expires_at <= statement_timestamp()` is true, and
B takes over. B's `collect` then replays A's committed active batch (`:537-557`), while A also returns it. That
means two responses carry the same lease ids under the one `listener_instance_id`.

This does not give a delivery to a second claimant. There is still one active batch (unique index) and no second
claim. Ack is idempotent per lease. It is the same result as the designed replay after a lost response, and the
first transaction has had the same property since round 1. But the test at `h0-poll-ack.test.ts:601`, "a stalled
slice cannot return a batch after its seat lock ends", covers a stall before `FOR UPDATE`, not a stall after the
hold check. The LANE.md sentence "if the holder or expiry changed, the old slice returns `h0_poll_lock_ended`" is
true only for a change made before the slice gets the row lock. Suggest: rename the test ("a slice blocked on its
seat row cannot collect after the lock ends"), and record the more-than-6-s-in-one-transaction window in LANE.md.

### R2: RIGOUR. The poll catalog verifier accepts several malformed poll schemas. The RUNBOOK says a malformed catalog fails.
`verify-h0-poll-catalog.sql` checks column name, type, and NOT NULL. It checks owner and RLS flags, six
`has_table_privilege` probes, trigger name, `tgenabled`, and `tgtype = 27`. It checks one named policy's
flags and roles, three indexes, and five function bodies, owners, `prosecdef`, and PUBLIC EXECUTE. It does not
check:
- constraints: the PK on either table, the two FKs to `agent_principals`, `CHECK (status IN (...))`,
  `CHECK (cardinality(lease_ids) BETWEEN 1 AND 10)`, the status/closed_at CHECK, or `CHECK (expires_at >=
  acquired_at)` (000001 `:19-30`, `:83-99`);
- column defaults (`acquired_at`, `created_at`, `waiting`);
- the trigger's target function (`tgfoid`). A trigger named `h0_poll_batches_guard` that points at another
  function passes while the pinned guard body sits unused;
- `proconfig`. A SECURITY DEFINER purge or retention function without `SET search_path = swarm, pg_catalog`
  passes;
- the exact ACL. `TRUNCATE` for `swarm_command` (TRUNCATE skips row triggers) or grants to other roles pass;
- extra policies, or the policy's `USING` / `WITH CHECK` expressions;
- the `h0_poll_locks_waiting` index definition (existence only).

`verify-h0-catalog.sql` checks all of these for the join tables (exact `acl`, `constraints`, `triggers[].definition`,
`policies[].using/check`, `config`). The apply branches install pinned bytes, so the risk is limited to the skip
branch on a recovery snapshot. RUNBOOK.md:80 ("A partial or malformed catalog fails") and LANE.md ("checks poll
columns, owner, RLS, grants, guard triggers and functions, indexes") claim more than the file checks. Either use
the join verifier's exact-JSON form for the two poll tables, or narrow the wording.

### R3: RIGOUR. The committed evidence says the fold-3 gates and the mutation control did not run.
LANE.md "Fold 3" at f1ba1fb3: "Local PostgreSQL and server-test results for this fold are not established here.
The plain-SELECT mutation could not run for the same reason." Also: `test:p1-server` "exit 1; 212 tests, 0 pass";
`test-h0-upgrade.py` "exit 1 at Docker startup"; "No commit was made"; and `git diff --check a103a512...HEAD` "does
not include Fold 3". The lead's results (test:p1-server 237, test:h0-upgrade:local 0, the FOR UPDATE mutation
failing then passing) are in the review brief only. The artifact on the branch therefore contradicts the gate claims
that the landing will rely on. Per AGENTS.md "Corrections go in the artifact", add the lead's commands, exit codes,
counts, and the mutation result to LANE.md, or mark the Maker's figures as superseded. I did not run any of these
gates, so I cannot confirm either set.

### R4: RIGOUR (minor). The poll guard orphan check does not cover the 000003 functions.
`apply-h0-upgrade.sh:73-79` refuses `h0_poll_locks_guard` / `h0_poll_batches_guard` without poll tables. A leftover
`purge_expired_h0_poll_batches`, `h0_poll_batch_retention_days`, or cron row with no poll tables is silently
replaced by `CREATE OR REPLACE` / `cron.schedule`. The effect is small, because those objects are then re-verified
by body hash. But the rule "Do not silently overwrite a damaged predecessor" (`:71-72`) is not applied to them.

## Not established by this review

- I ran no test, no `deno check`, no `check:tests`, no Docker gate, and no mutation. All pass counts are the
  lead's or the Maker's.
- How 000001-000003 reach the live box is not established. The brief names `deploy/RELEASE-TO-BOX.md` as the
  production path. That file is not in f1ba1fb3 or `main`. It exists only on `origin/docs/release-to-box`
  (55cc8401), where its H0 ledger step names only `20260916000001` and `20260916000002` (`:564`). AGENTS.md at
  f1ba1fb3 also says no written procedure exists yet.
- Box abort propagation through `worker.fetch(forwarded)` is not established. LANE.md records this correctly.
- I did not check `enforceAgentSessionProof` in full for row locks. The first 40 lines take none. If it locked a
  row, the order would be session row → R in every path, so no cycle is added either way.
- Worker behaviour under `--max-parallelism 4` and the worker wall clock: as in rounds 1 and 2, not established.

The data paths are correct. Fold 3 closes both Codex round-2 PRODUCTION findings (000003 on the box path; the
unlocked slice check) and the round-2 RIGOUR items. It adds no deadlock and holds no transaction across the sleep,
and the 204 leaves no slot or lease in a wrong state. One regression blocks it: the new unconditional purge-job
expectation refuses the documented post-H0 recovery (P1). The fix is small.

VERDICT: FAIL
