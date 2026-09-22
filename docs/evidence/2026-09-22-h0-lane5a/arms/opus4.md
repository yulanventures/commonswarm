# D-036 Checker review, round 4 (Claude Opus arm): H0 lane 5a at 6f4395c8

Scope: `git diff f1ba1fb3...6f4395c8` (folds 4 and 5, 18 files), the whole lane diff `a103a512...6f4395c8`
where folds 4-5 touch it, LANE.md "Fold 4" and "Fold 5", round-3 reviews (opus-r3.md FAIL, grok-r3.md FAIL), and
`deploy/RELEASE-TO-BOX.md` sections 3-5 from `origin/main` (844d0de2). I read code from a `git archive 6f4395c8`
export in my scratchpad (not a worktree). I edited no repo file, committed nothing, and contacted no network host.

What I ran (all local, all at 6f4395c8, from the scratchpad export):
- `python3 deploy/supabase-stack/migrate/test-h0-upgrade.py`: exit 0, `PASSED 37 real PostgreSQL H0 gates`
  (its own throwaway container `h0-catalog-test-*`, removed by the script).
- `python3 deploy/supabase-stack/migrate/test-post-upgrade-counts.py`: 16 tests, OK.
- `node --import tsx --test` on the seven pure test files that import the changed edge files
  (`tests/listener-runtime`, `delivery-client`, `claim-ledger-parse`, `protocol-workspace`,
  `tests/p1-cli/h0-verbs`, `h0-poll-contract`, `h0-agent-document`): 201 pass, 0 fail.
- One throwaway container `opus4-probe-12771` (`public.ecr.aws/supabase/postgres:17.6.1.147`, no published port,
  removed afterwards; `docker ps -a` shows no leftover). I applied the synthetic baseline from
  `test-h0-upgrade.py`, the two join migrations, and 000001-000003 one at a time, then ran the probes below.

I did not run `test:p1-server`, `npm test`, `test:p1-cli`, `check:edge`, or `build-release.sh` (the local
Supabase stack and CLI-spawning suites are outside what this brief allows me to touch).

## Fold claims, checked

1. **One lock order: holds.** `poll-ack.ts:323-332` `lockPollPrincipal` (`FOR NO KEY UPDATE`) runs right after
   `authenticate` and before `sessionOrRefusal` in the opening transaction (`:865`) and in every slice (`:930`).
   Per path at 6f4395c8:
   - opening: token stamp (first use only) -> principal NO KEY UPDATE -> principal FOR SHARE + session FOR SHARE
     (same tx, no self-conflict) -> seat row (`acquireLock` ON CONFLICT, `:683`) -> batch rows -> delivery rows;
   - slice: same order, seat row via `readWaitHold` `FOR UPDATE` (`:782-788`);
   - `claimWaitingSlot` / `releaseLock` (`:706-754`): advisory -> seat row. They start a fresh transaction,
     take no principal, and take no advisory after the seat row;
   - `claimAgentInbox` (`durable-delivery.ts:205-212`): principal NO KEY UPDATE; inside a poll the lock is
     already held;
   - h0 ack (`:1023-1031`) and command-edge ack: principal FOR SHARE (session fence) -> delivery row. A poll
     cannot hold NO KEY UPDATE while an ack holds FOR SHARE, so the poll's non-SKIP-LOCKED delivery UPDATEs
     (`durable-delivery.ts:219-297`) can never wait on an ack that waits on the poll.
   The only advisory waiters hold nothing else, so no cycle can pass through the advisory lock. No path takes
   the seat row before the principal. Grok's round-3 cycle (slice: seat -> principal upgrade; second poll:
   principal FOR SHARE -> seat) is gone, because both now take principal NO KEY UPDATE first.
2. **FOR NO KEY UPDATE still serializes every writer: holds.** Every writer of `swarm.agent_principals`:
   - `command/index.ts:4294` UPDATE `model` -> NO KEY UPDATE;
   - `:4357` UPDATE `revoked_at` (revoke agent), then `rotateWakeId` -> UPDATE `wake_id`, a column of the
     non-partial unique index `agent_principals_wake_id` (`20260906000010:29`) -> FOR UPDATE;
   - `:6819` UPDATE `revoked_at` of a join registrar -> NO KEY UPDATE;
   - `:11550` `lockHumanManagedPrincipal` FOR UPDATE OF p, then `:11593` / `:11665` UPDATE `managed_at`;
   - `:11777` acquire session SELECT FOR UPDATE;
   - `20260906000010_wake_delivery.sql:115` wake-id rotation function -> FOR UPDATE;
   - INSERTs `:4271`, `:6321`, `:6593` (new rows), `src/cloud/seed.ts:157` (dev seed).
   Readers: `enforceAgentSessionProof` FOR SHARE (`agent-auth.ts:223-228`); FK checks KEY SHARE. No explicit
   `FOR KEY SHARE` exists in `supabase/` or `src/`; no migration function locks the principal row.
   Every UPDATE, FOR UPDATE, and FOR SHARE conflicts with NO KEY UPDATE; only KEY SHARE does not. Probe with
   a holder of `FOR NO KEY UPDATE` and `lock_timeout=500ms`: FOR KEY SHARE granted; an `h0_poll_locks` INSERT
   (FK) granted; FOR SHARE, UPDATE `revoked_at`, and a second FOR NO KEY UPDATE all timed out.
3. **Command-edge claim for non-H0 seats: behaves as before except that FK inserts no longer wait.** The only
   change is `durable-delivery.ts:211`. Claims still serialize on the principal, revoke/model/managed changes still
   serialize against the claim, and `revoked_at` is re-read under the lock (`:213-216`). New deliveries inserted
   during a claim are not visible to it and go to the next claim, the same as a row inserted just after commit.
   The Phase B tests now pin `/FOR NO KEY UPDATE/` (`command.test.ts:10181`, `:10307`, `:10918`); that
   string does not contain `FOR UPDATE`, so the regex still identifies the claim lock. The H0 fence in
   `command/index.ts` and the three listener clients are unchanged since f1ba1fb3.
4. **503 on 40P01/40001: holds, D-053 clean.** `poll-ack.ts:133-138` classifies on `error.code` (SQLSTATE) only.
   `h0/index.ts:46-52` logs only a code matching `^[0-9A-Z]{5}$`. A 503 can come only from a transaction that
   rolled back. A batch committed by the opening transaction is replayed by the next poll.
5. **Restore-safe cron count: holds.** `verify-post-upgrade-counts.sh` adds the purge record only when the
   baseline has none. The awk parser matches the `json_build_object` format of `cron_jobs_json_sql`
   (`lib.sh:206-218`). A line it cannot parse makes awk `exit 1`, and `set -euo pipefail` (line 2) stops the
   script, so it fails closed. `test_recovery_keeps_existing_purge_job_once` fails on the round-3 code (expected
   would hold the record twice) and passes now, so it discriminates. Round-3 P1 is closed.
6. **Exact-JSON poll verifier: matches PG 17 and rejects the round-3 cases.** On the probe it returned 0 on the
   clean catalog. Each of these mutations, in its own rolled-back transaction, was rejected with the named
   exception: extra policy; changed policy USING; changed column default; extra index on `h0_poll_locks`;
   dropped FK; NOT VALID check; trigger WHEN clause; trigger ENABLE REPLICA; extra trigger; FORCE RLS; SELECT
   granted to anon; PUBLIC EXECUTE on the retention function; a third `purge_expired_h0_poll_batches`
   overload; `indisvalid=false`; cron job inactive; `fillfactor` reloption; and the one-active index on
   `(batch_id) WHERE status = 'active'`. The harness adds wrong predicate, wrong trigger function, TRUNCATE grant,
   and reset search_path. Round-3 R2 and Grok's predicate finding are closed.
7. **Orphan refusal: holds** (`apply-h0-upgrade.sh:72-78`), with three harness cases. Round-3 R4 is closed.
8. **Release proofs: meet the section 5 form.** Each catalog file ends with `\gset` on the line after one
   SELECT of one Boolean aliased `catalog_ok`. It prints nothing else, so the preflight `-Atq` capture is exactly
   `t`/`f`. It is read-only and uses `to_regclass`/`to_regprocedure`, so an absent object gives false, not an
   error. Probe: all three `f` before any poll migration, all three `t` after 000001-000003. The harness shows
   `f` before and `t` after each migration applied alone, in order. I checked the NULL case: `\gset` of a NULL
   leaves `catalog_ok` unset, and the wrapper's `\if :{?catalog_ok}` then prints `invalid`. The top-level
   expressions cannot give NULL once any EXISTS is false. The functional files are DO blocks with no writes, so
   they suit `release_psql_ro` (`default_transaction_read_only=on`, `ON_ERROR_STOP=1`).
   `username=current_user` in the 000003 proof holds on the box, because `release_psql` and `release_psql_ro` use
   the same `target` service (supabase_admin) (RELEASE-TO-BOX.md section 3).
9. **Test seats: hold.** `makeSeat()` mints a one-seat credential, registers, and revokes the credential.
   `revokeAgentJoinCredential` revokes only the registrar principal (`command/index.ts:6818-6823`), not the
   joined seat. The new lock-order test (`h0-poll-ack.test.ts:603`) reaches its claim. With
   `lockPollPrincipal` removed, the slice takes principal FOR SHARE (compatible with the test's holder), then
   the seat row, then blocks on the claim's NO KEY UPDATE while it holds the seat row. The `FOR UPDATE NOWAIT`
   probe then fails. With the fix, the slice blocks before the seat row. The file is reached by the
   `test:p1-server` glob.

## Findings

### R1: RIGOUR. The 000001 catalog proof returns `t` for a one-active index on the wrong columns.
`deploy/release-proofs/h0/20260922000001-catalog.sql:54-56`:
```
AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_batches_one_active')
  AND i.indrelid=to_regclass('swarm.h0_poll_batches') AND i.indisunique AND i.indisvalid
  AND pg_get_expr(i.indpred,i.indrelid) = '(status = ''active''::text)')
```
Only the predicate is compared. Probe: after `DROP INDEX swarm.h0_poll_batches_one_active; CREATE UNIQUE INDEX
h0_poll_batches_one_active ON swarm.h0_poll_batches (batch_id) WHERE status = 'active'`, the proof printed
`[t]`. That state does not enforce one active batch per seat. It also stays `t` with an extra index on
`h0_poll_locks`, an extra trigger on `h0_poll_batches`, and a guard function made SECURITY DEFINER with PUBLIC
EXECUTE. The exact verifier rejects all of these. The section 5 contract says `t` "only when that migration's
real catalog/data postcondition is complete". Such a state cannot come from applying 000001 itself, because
`CREATE TABLE` / `CREATE UNIQUE INDEX` there have no `IF NOT EXISTS`. So the risk is limited to the `0:t` →
Ledger backfill route, where section 4 says the version's reviewed catalog query does the proving. Fix: compare
the full `pg_get_indexdef` as the 000003 proof and the verifier do. Consider exact index and trigger sets per
table.

### R2: RIGOUR. The 000001 proof's FK strings depend on the session search_path.
`20260922000001-catalog.sql:33-35`, `:42-44` compare `pg_get_constraintdef(c.oid,true)` with
`'... REFERENCES swarm.agent_principals(...)'`. With the pretty flag, Postgres qualifies the referenced table
only when it is not visible on the search_path. Probe: the default supabase_admin path (`"$user", public, auth,
extensions`) gives `[t]`. After `SET search_path = swarm, public`, the same catalog gives `[f]`. The verifier
avoids this with `SET LOCAL search_path = pg_catalog`. The failure is closed (the apply transaction would roll
back a correct migration). No repo migration sets a persistent search_path for supabase_admin; only
`swarm_command` has one (`p1_schema.sql:99`). But the proof depends on a session setting that the contract does
not fix. Fix: use `pg_get_constraintdef(c.oid)` (non-pretty always qualifies) or compare `confrelid` and
`conkey`/`confkey`.

### R3: RIGOUR. The committed record does not establish the pure gates at 6f4395c8.
`docs/evidence/2026-09-22-h0-lane5a/LANE.md:472-477`: "`npm test` exited 1 (894 pass, 2 sandbox `spawn EPERM`
failures ...). `npm run test:p1-cli` exited 1 ... it did not establish a full CLI gate result." The lead's
measurements in the record are for f1ba1fb3. Folds 4-5 change no `src/` and no pure test file. The pure suites
reach the changed code only through the seven files listed above. I ran those: 201 pass. That narrows the gap
but does not replace the two package gates. Measure `npm test`, `npm run test:p1-cli`, and `npm run check:edge`
at 6f4395c8 and record them in LANE.md, as was done for fold 3. I also did not reproduce `test:p1-server
238/238` or the two mutation controls.

### R4: RIGOUR (minor). The 503 branch is not reached by any test, and the handler's own lock timeout still answers 500.
`poll-ack.ts:133-138` returns `{ error: "h0_transaction_retryable" }` with no `message` and no
`retryAfterSeconds`. The code is a literal, not a constant in `parse.ts` like the other h0 codes. No test
produces 40P01 or 40001, so the branch is untested. `setRole` sets `lock_timeout = '5s'` (`:190`). Its SQLSTATE
`55P03`, the transient failure Fold 5 met, still falls through to `h0VerbFailure()` → 500 `internal_error`.
A seat that posts a long command holds its own principal FOR SHARE. That makes the next slice wait on NO KEY
UPDATE, and after 5 s it gets a 500. That behaviour was already there before fold 4 (the claim's lock conflicted
the same way). Consider mapping `55P03` to the same 503, exporting the code, and adding one test.

### R5: RIGOUR (minor, present since round 1). A revoke that commits between `authenticate` and the principal lock can still get an active-batch replay.
`authenticate` (`poll-ack.ts:246-290`) reads `principal_revoked_at` with no lock. `lockPollPrincipal`
(`:324-330`) then waits for a concurrent revoke, but it selects only `principal_id` and does not re-check
`revoked_at`. `collect` returns an active batch (`:560-580`) without `claimAgentInbox`, which is the only place
that re-reads `revoked_at` under the lock (`durable-delivery.ts:213-216`). In that microsecond window, a seat
revoked mid-request can get a replay of leases it already holds. No new message is claimed. Adding `AND
revoked_at IS NULL` to the locked read (and refusing on zero rows) closes the gap at no cost, now that the lock
exists.

### R6: RIGOUR (minor). The duplicate-purge counts test fails for a different reason than its name says.
`test-post-upgrade-counts.py:61-63` (`test_duplicate_purge_in_baseline_fails`): the baseline has two purge
records and the stubbed target has one. The script has no duplicate check. It passes the baseline through when
the count is not 0, so the test fails on the multiset mismatch in `compare_cron_job_listings`. A baseline and
target that both hold two purge rows would pass this script. The catalog verifier (`verify-h0-poll-catalog.sql`,
cron count `<> 1`) is what refuses that case. Rename the test, or add an explicit "at most one" check.

## Not established by this review
- `test:p1-server`, `npm test`, `test:p1-cli`, `check:edge`, `build-release.sh`, and both mutation controls
  (old lock order; exact index comparison) at 6f4395c8. The figures are the Maker's.
- The box's supabase_admin search_path (R2), and whether the H0 poll migrations will reach the box through
  section 5 (`0:f` → apply) or through `apply-h0-upgrade.sh` plus a Ledger backfill (`0:t`).
- Worker behaviour under `--max-parallelism 4`, and abort propagation through `worker.fetch(forwarded)`
  (unchanged since earlier rounds; LANE.md records them as not established).
- Noted, not introduced by this lane: a command-edge `claim_agent_inbox` takes the principal FOR SHARE in the
  session fence (`command/index.ts:8931`), then NO KEY UPDATE in `claimAgentInbox`. So two concurrent
  command-edge claims by one principal can still deadlock (40P01). That was the same with `FOR UPDATE` at
  a103a512. The Phase B cap test calls `claimAgentInbox` directly, so it does not cover this path. H0 paths do not
  take that upgrade: the poll locks NO KEY UPDATE first, and ack takes only FOR SHARE.

Folds 4 and 5 close both round-3 FAILs: the Grok deadlock (one principal-first order, with a discriminating
test) and my P1 (restore-safe purge count). They also close round-3 R2 and R4 and Grok's predicate RIGOUR item,
each confirmed on PostgreSQL 17.6. The NO KEY UPDATE change still serializes every writer of `agent_principals`
against the claim, and it no longer blocks signal writers' FK locks. I found no PRODUCTION defect. The remaining
items are proof precision (R1, R2), unrecorded gates (R3), and minor hardening (R4-R6).

VERDICT: PASS
