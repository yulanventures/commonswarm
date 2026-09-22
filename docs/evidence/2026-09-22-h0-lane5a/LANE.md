# H0 lane 5a — poll, ack, and the listener fence

Branch `lane/h0-poll-ack` from `a103a512`. Nothing in this lane is deployed.

## Effect ordinal

`SWARM-CLOUD.md:470` wants a per-message ack keyed by message id and effect ordinal.
The message id is `signal_id` on `POST ack`. The effect ordinal is the agent's
`requestId` on ask, note, reply, and working-on. Lane 5b forwards those verbs.
This lane does not add an ordinal field to the ack wire. The ack field set stays
the `AckAgentDeliveryCommand` set.

## Fence

Code: `h0_seat_uses_poll`, constant `H0_SEAT_CLAIM_REFUSED` in
`supabase/functions/command/h0-seat.ts`.

Call: `supabase/functions/command/index.ts`, in the delivery block, only when
the kind is `claim_agent_inbox`. It runs before the idempotency replay and
before the only `claimAgentInbox` call. Ack is not refused. The h0 poll calls
`claimAgentInbox` directly and does not pass through this branch.

A principal is an H0 seat when `swarm.agent_join_attempts` names that principal
in the routed workspace.

Message: the seat receives messages through `POST /functions/v1/h0/poll`.
`claim_agent_inbox` does not deliver to it.

## Records

Migration `supabase/migrations/20260922000001_h0_poll_lock_and_batch.sql`.
Owner `swarm_admin`. RLS on. `swarm_command` may select, insert, and update.

`swarm.h0_poll_locks`

- Primary key `(workspace_id, principal_id)`.
- Holds `holder`, `listener_instance_id`, `acquired_at`, `expires_at`,
  and `waiting`. `waiting` is the deployment-wide slot. See Fold 1.
- Check: `expires_at >= acquired_at`.
- The writer sets expiry to the wait plus 5 seconds of cleanup plus 1 second.
  At a 50 second wait that is strictly longer than 50 seconds plus cleanup.
- Trigger `h0_poll_locks_guard` refuses delete and refuses a change to
  `listener_instance_id`.

`swarm.h0_poll_batches`

- Primary key `(workspace_id, principal_id, batch_id)`.
- Stores `lease_ids` (1 to 10), `status` (`active` or `closed`), `expires_at`,
  `closed_at`.
- Unique index `h0_poll_batches_one_active` on `(workspace_id, principal_id)`
  where `status = 'active'`. That is the unique-active constraint.
- Trigger `h0_poll_batches_guard` refuses delete and refuses a change to
  `lease_ids`. An active row may move `expires_at` earlier. Closing sets
  `closed_at`.

An expired batch is closed. Its stored lease ids are not written back onto
delivery rows. `claimAgentInbox` re-claims rows whose leases have expired.

## Poll and ack

Seat token in `Authorization: Bearer` only. A query credential is
`h0_bearer_query_refused`.

`POST poll` body, from `src/h0/verbs.ts` and `supabase/functions/h0/parse.ts`:

- `wait`, omittable, integer seconds, 0 to 50. Above 50 is `h0_poll_wait_refused`.
- `ackBatch`, omittable, the previous `batchId`. It closes that batch and
  changes no delivery column.

`POST poll` response:

- `batchId` (null when there is nothing to return)
- `listener_instance_id` (stable per seat)
- `deliveries` (own unacknowledged unexpired leases first, then newly claimed
  rows, at most ten, oldest first)

A second poll while the lock is held returns HTTP 409 `h0_poll_in_progress`.
When this poll's own lock has ended, the code is `h0_poll_lock_ended`, also HTTP 409.
The wait is slices of 1 second. Each slice re-runs authentication and the claim.
That work is one transaction. Between slices the transaction has ended. The
Postgres connection stays open for the whole wait: the pool idle timeout is
3 seconds, and a slice is 1 second. The wait ends at the lock row's
`acquired_at` plus the requested wait, and not after that row's `expires_at`.
Both timestamps were written with `statement_timestamp()`.

`POST /h0/poll` accepts any live seat, not only an H0 seat. Authentication
checks the seat token and the membership. It does not read
`swarm.agent_join_attempts`. The H0 marker is the claim fence only.
`claim_agent_inbox` refuses a principal that has a join-attempt row. Poll
calls `claimAgentInbox` for the authenticated seat, so a seat with no
join-attempt row can poll. The fence does not run in the other direction.

An active batch whose leases are all acked is replayed with that `batchId`
and `deliveries: []` until the batch expires, if the agent never sends
`ackBatch`. `listedLeaseRefs` returns only unacked unexpired leases. The
batch stays active, so a later poll does not claim new rows.

A retry that sends a stale `ackBatch` after the response was lost gets
HTTP 409 `h0_ack_batch_mismatch`. The message says to poll again without
`ackBatch`. That next poll replays the active batch.

`POST ack` body: `signal_id`, `lease_id`, `listener_instance_id`, `outcome`,
`last_error_code`, and omittable `surfaced`. It calls `ackAgentDelivery`.

`POST ack` response: `ok`, `status: "accepted"`, `signal_id`, `outcome`.

Every h0 response sets `Cache-Control: no-store` and
`x-robots-tag: noindex, nofollow, noarchive`. Poll and ack do not send
`Access-Control-Allow-Origin: *`.

Database settings use the command names: `SWARM_DATABASE_URL`, else
`SUPABASE_DB_URL`, and `SWARM_DATABASE_TLS_CA_B64`.
`FUNCTION_ENV_NAMES.h0` lists those three. `supabase/functions/h0/deno.json`
maps `postgres` so local `functions serve` can load the delivery module.
The box bootstrap still copies `deploy/edge-runtime/h0-deno.json`, which has
the same map.

## Mutation

The refusal test was run with the fence return disabled
(`if (false && refusal !== null)` in the claim branch).

Command:

`env -u FORCE_COLOR node --import tsx --test --test-concurrency=1 --test-name-pattern "claim is refused" tests/p1-server/h0-poll-ack.test.ts`

Exit 1. The claim returned HTTP 200 and a delivery, where the test requires
HTTP 403. The condition was restored. `false && refusal` is not in the file.

## Tests and the script that runs them

- `tests/p1-cli/h0-poll-contract.test.ts` — `npm run test:p1-cli`. Not in the
  literal `npm test` list.
- `tests/p1-server/h0-poll-ack.test.ts` — `npm run test:p1-server`.

## Not established

- The running box does not yet pass these database names into the h0 worker.
  The names are listed in this tree. Deploy was not run.
- `deploy/supabase-stack/migrate/apply-h0-upgrade.sh` applies the two
  2026-09-16 files and all three 2026-09-22 poll files in order. The retired
  wording said it applied only the 2026-09-16 files, then later said it
  applied only the first two poll files. Deploy was not run.
- The post-upgrade check expects the source cron set plus exactly one
  `swarm-purge-h0-poll-batches` job. The retired wording said it expected
  the source cron set unchanged. The box was not checked.
- H0 poll and ack do not use the command edge's delivery rate buckets.
- Register, ask, note, reply, and working-on are not forwarded. That is lane 5b.
- No detached `cswarm listen` was started. The fence was measured through the
  command HTTP claim.

## Fold 1

`H0_MAX_CONCURRENT_WAITS` is 1. It is defined in `src/h0/verbs.ts`. The poll
note, the tests, and `deploy/edge-runtime/README.md` read that constant.
`H0_POLL_RETRY_AFTER_SECONDS` is 5, in the same file.

The slot is the column `waiting` on `swarm.h0_poll_locks`. A row counts while
`waiting` is true and `expires_at` is in the future. The count has no
workspace filter. Migration
`supabase/migrations/20260922000002_h0_poll_wait_admission.sql`.

The claim is one transaction in `claimWaitingSlot`. It takes
`pg_advisory_xact_lock(hashtext('h0-wait-admission'), hashtext('deployment'))`,
then sets `waiting` on this holder only when that count is below the constant.
The second worker blocks on the lock until the first transaction commits, so
it sees the first row. Two workers cannot both pass.

A poll that cannot take a slot does not wait. It returns HTTP 200. The body
is the empty poll shape plus `retryAfterSeconds`:

- `batchId`: null
- `listener_instance_id`: the seat's id
- `deliveries`: []
- `retryAfterSeconds`: 5

That response is not an error.

`releaseLock` sets `waiting` to false and `expires_at` to now. The poll
handler calls it from `finally` on every exit after the per-seat lock is
held. A row whose release does not run stops counting when `expires_at`
passes. A later poll that takes an expired row sets `waiting` to false.

Mutation: `H0_MAX_CONCURRENT_WAITS` was set to 2. The test "one waiting poll
is admitted for the whole deployment" failed, exit 1. The first poll returned
in 4493 ms. The assertion message was `the poll that could not wait took
4493ms (cap 2)`. The constant was restored to 1. The file then passed, 9
tests, exit 0.

The local `tests/p1-server/h0-poll-ack.test.ts` run is the measurement. The
box was not exercised.

## Fold 2

The review pair was Codex FAIL and Opus PASS. The lead ruled on the code.
These are the fixes.

1. The wait reads `request.signal`. An abort ends the current 1 second sleep
   and the same `finally` path releases the slot. The local gateway does not
   abort the edge request, so the test calls `handleH0PollRequest` with a
   Request whose signal it aborts. The test "an aborted waiting poll frees
   the slot for another seat" requires the slot to be free within 2000 ms,
   then shows a second seat can wait.

2. `apply-h0-upgrade.sh` pins and applies the two poll migrations after the
   two join migrations. The same checks are used: the file exists, the SHA
   matches, an orphan guard with no table is refused, and the SQL is one
   transaction. If the join tables are already present and the poll tables
   are absent, it applies only the two poll files, in order. If all four
   tables are present, it skips. `verify-post-upgrade-counts.sh` allows the
   two poll tables at zero when the source baseline lacked them.
   `deploy/supabase-stack/migrate/test-post-upgrade-counts.py` pins that
   list. `test-h0-upgrade.py` requires both poll tables after apply.

3. The wait deadline is the lock row's `acquired_at` plus the requested
   wait. Each slice reads that row's holder, `acquired_at`, and `expires_at`
   with `clock_timestamp()`. The slice stops when the holder differs, when
   `expires_at` has passed, or when `acquired_at` plus the wait has passed.
   The test "the wait ends from the lock row, not from a clock started after
   the claim" moves `acquired_at` an hour back and keeps `expires_at` an
   hour ahead. The poll returns empty in under 5 seconds.

4. When this poll's own lock has ended, the code is `h0_poll_lock_ended`.
   A second poll that overlaps a live lock is still `h0_poll_in_progress`.
   The test "a poll whose own lock ends returns h0_poll_lock_ended" sets
   the row's expiry in the past and requires the new code.

5. Closed batches are retained by `swarm.purge_expired_h0_poll_batches`.
   `H0_POLL_BATCH_RETENTION_DAYS` is 2. The floor is
   `GREATEST(2, h0_poll_batch_retention_days)`. The guard and the purge read
   `swarm.h0_poll_batch_retention_days()`. The guard still refuses a delete
   of an active batch and of a closed batch younger than that age. The test
   "closed poll batches older than the retention age can be deleted" deletes
   a 3-day closed batch, refuses an active batch and a 1-day closed batch,
   and shows a config value of 1 does not shorten the floor. The daily cron
   name is `swarm-purge-h0-poll-batches`. It is not on the box upgrade path.
   See Not established.

6. The test "removing the fence makes the refusal assertion fail" compared
   a hard-coded literal and could not fail. It is deleted.
   `tests/p1-cli/h0-poll-contract.test.ts` no longer has it. The fence
   proof is the server test "an H0 seat claim is refused, its ack is
   accepted, and a plain seat still claims". The manual mutation in the
   Mutation section above stays.

7. The test "a poll cannot take the waiting slot while the admission lock
   is held" holds `pg_advisory_xact_lock(hashtext('h0-wait-admission'),
   hashtext('deployment'))` on another connection. The poll publishes its
   seat lock and does not set `waiting` while that lock is held. After the
   lock is released, the poll sets `waiting`. Mutation: `lockWaitAdmission`
   no longer called `pg_advisory_xact_lock`. The same test failed, exit 1.
   The assertion was "the poll took the slot while the admission lock was
   held", actual 1, expected 0. The call was restored. The file was run
   again. See the rerun recorded below.

8. `h0_ack_batch_mismatch` is unchanged. The message now says to poll again
   without `ackBatch`. The test "a retried stale ackBatch says to poll again
   without ackBatch" closes a batch, discards the next response, sends the
   old `ackBatch` again, gets HTTP 409 with that message, then polls without
   `ackBatch` and receives the active batch.

9. F7, F9, and the wait description are in Poll and ack above. F10: the CLI
   listener treats `DeliveryHttpError` status 403 as credential loss
   (`isDeliveryCredentialLoss` in `src/listener/runtime.ts`). The claim loop
   uses that predicate. The fence returns HTTP 403 `h0_seat_uses_poll`. The
   listener does not read that code, so it stops as credential loss. This
   lane does not change `src/listener`. The listener lane has that fix.

Fold 2 rerun of `tests/p1-server/h0-poll-ack.test.ts` after the advisory
lock was restored: 15 tests, exit 0. The box was not exercised.

## Fold 3

Each wait slice now uses `SELECT ... FOR UPDATE` on its seat lock row inside
the transaction that calls `collect`. The holder and expiry are checked after
the row lock is acquired. A takeover waits for that transaction to commit;
if the holder or expiry changed, the old slice returns `h0_poll_lock_ended`.
The new server test holds that row from another connection, makes a delivery
available, and ends the old lock while the slice is blocked. It requires the
old poll to return 409 and only the next poll to receive the delivery. A plain
SELECT would let the old poll finish while the test holds the row.

The box upgrade now pins and applies `20260922000003` after `000002`. Its
one transaction runs both `verify-h0-catalog.sql` and
`verify-h0-poll-catalog.sql`. The latter checks poll columns, owner, RLS,
grants, guard triggers and functions, indexes, purge functions, and the one
named cron job. It also runs on the all-tables-present skip branch. The
post-upgrade count verifier expects the original cron listing plus exactly
one new purge job. The isolated upgrade test now sets up the live-box branch
with join tables present and poll tables absent, then exercises poll catalog
mutations. The closed batch purge has an index on `closed_at`. Migration
`000001` keeps its header comment together.

`H0ClientAbort` is a named class. The h0 entrypoint turns that class into a
quiet 204 response and leaves other failures on the error path. The abort
test child receives only the loopback database URLs and its required local
process values; it does not inherit an exported database URL or TLS CA.
The batch guard test classifies SQLSTATE `55000` without reading message text.

**Box abort propagation is not established.** The repo pins
`public.ecr.aws/supabase/edge-runtime:v1.73.13` and calls
`worker.fetch(forwarded)`; `rewriteFunctionRequest` carries the Request's
signal. No vendored or cached v1.73.13 `UserWorker.fetch` type or source was
found offline. The exact box question is: *does an aborted client request to
the main service abort the `Request.signal` seen by the h0 user worker when
`worker.fetch(forwarded)` is called without a second options argument?* If
not, does v1.73.13 support `worker.fetch(forwarded, { signal: request.signal })`?
No gateway signal change was guessed. The handler-level abort is established
only with an injected Request signal.

The sandbox denied the Docker socket during the isolated upgrade test. Local
PostgreSQL and server-test results for this fold are not established here.
The plain-SELECT mutation could not run for the same reason. The test is
written to fail if a slice collects while another transaction holds the row.

Fold 3 gate results in this sandbox:

- `npm run build`: exit 0.
- `env -u FORCE_COLOR npm test`: exit 1; 894 tests, 842 pass, 50 fail,
  2 skipped. Local listener sockets failed with `listen EPERM`.
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 1; 826 tests, 717 pass,
  103 fail, 6 skipped. Local socket tests failed with `listen EPERM`.
- `npm run check:tests`: exit 0.
- `npm run check:edge`: exit 0.
- `env -u FORCE_COLOR npm run test:p1-server`, alone: exit 1;
  212 tests, 0 pass, 196 fail, 16 cancelled. `supabase status -o json`
  failed before the tests reached local PostgreSQL.
- `python3 deploy/supabase-stack/migrate/test-post-upgrade-counts.py`:
  exit 0, 14 tests. Missing and duplicate purge jobs are negative controls.
- `python3 deploy/supabase-stack/migrate/test-h0-upgrade.py`: exit 1 at
  Docker startup: permission denied on the Docker API socket. No catalog or
  branch test ran.
- `bash scripts/build-release.sh`: exit 0; the artifact ran and reported
  version 0.1.72.
- `git diff --check` on the working tree: exit 0.
- `git diff --check a103a512...HEAD`: exit 0, against the unchanged
  `3dc812c9` HEAD. It does not include Fold 3 because the commit was blocked.

`git add` could not create this worktree's git index lock under the shared
checkout: `Operation not permitted`. No commit was made. The Fold 3 files
remain in this worktree for the lead to stage, run the local gates and mutation,
and commit. No production endpoint or host was contacted.

Requested commit message and trailers for the lead:

```text
fix(h0): lock the seat row across each poll slice; box path applies and verifies all three poll migrations

Agent-Name: Yulan Bot
Agent-Model: gpt-6
Agent-Family: openai
Agent-Tool: codex 0.156.0
Agent-Model-Source: runtime-ambiguous
```
