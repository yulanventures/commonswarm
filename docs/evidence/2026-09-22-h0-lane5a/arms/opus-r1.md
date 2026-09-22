# D-036 Checker review (Claude Opus arm): H0 lane 5a, bbee0033 (base a103a512)

Scope read: the full diff `git diff a103a512...bbee0033` (19 files), LANE.md with Fold 1, and spec sections 3, 4 and 6
(`spec/h0-link-join:docs/design/2026-09-15-H0-LINK-JOIN.md`). I also read the code the lane depends on:
`durable-delivery.ts` `claimAgentInbox` (lines 187-440), `_shared/agent-auth.ts` `loadAgentCredential` and
`agentCredentialRevoked`, the command-edge claim, replay and `resolveLedgerRace` branches, the three listener consumers,
`src/cloud/delivery.ts` `claimAgentInbox`, `deploy/edge-runtime/compose.yaml` and `main/index.ts`, and the
`agent_join_attempts` migration. I did not read the other arm's output.

## What holds (checked, not assumed)

- **The fence covers every listener path.** There are 3 `claimAgentInbox(` definitions or calls in `supabase/functions`:
  the definition at `durable-delivery.ts:187`, the command edge at `command/index.ts:10232`, and the h0 poll at
  `h0/poll-ack.ts:535`. `session-receiver.ts:121`, `agent-channel.ts:310` and `listener/runtime.ts:1390` all go through
  `DeliveryCommandClient.claimAgentInbox` (`src/cloud/delivery.ts:849`), which POSTs to `command`. The fence is at
  `command/index.ts:9302-9322`. It runs inside `if (kind === CLAIM_AGENT_INBOX_KIND || kind === ACK_AGENT_DELIVERY_KIND)`,
  before the idempotency replay (`:9387`) and before the claim call (`:10232`). That means a stored claim cannot bypass it.
  `resolveLedgerRace` (`:11051`) replays only the stored response of a winner that already passed the fence. The ack arm
  is not refused.
- **The fence key and the claim key agree.** Both use `route.workspaceId` and `agent.principal_id`. `principalIsH0Seat`
  (`h0-seat.ts:31-43`) reads `swarm.agent_join_attempts`. That table has `UNIQUE (principal_id)`, grants `SELECT` to
  `swarm_command`, and has a guard that refuses `DELETE` (`20260916000002_agent_join_attempts.sql:21,55,110`). So the
  marker cannot disappear, and the read cannot fail with a permission error for non-H0 seats.
- **The fence refusal is a stable code.** `h0_seat_uses_poll` is returned with 403 and an audit row. No new code
  branches on `error.message`. D-053 is clean: the only matches for `.message` in the diff are response construction or
  test equality.
- **Two H0 consumers cannot split one seat.** `acquireLock` (`poll-ack.ts:611-643`) is
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= statement_timestamp()`. A concurrent first poll blocks on the
  row, then matches nothing and gets 409. `listener_instance_id` is frozen by `h0_poll_locks_guard`, so all H0 leases
  carry one `leased_by`. Ack needs that id plus an unexpired lease.
- **The batch record matches the spec.** The primary key is `(workspace_id, principal_id, batch_id)`. The partial unique
  index `h0_poll_batches_one_active` enforces one active batch. `closeExpired` (`:433-442`) only closes a row. Rows
  re-claim through `claimAgentInbox` steps 2-4, so the TTL and the ten-attempt ceiling still apply. The server test at
  `h0-poll-ack.test.ts:514-549` shows `attempt_count` 2, `lease_expiry_count` 1, a new lease, and the old batch closed.
  `applyAckBatch` writes only `h0_poll_batches`. The test at `:490-512` asserts that lease, `acked_at`, attempts and
  outcome do not change.
- **A crash between claim and response loses nothing.** The claim, the leases and the active batch commit in one
  transaction (`:741-776` for the first pass, `:796-839` for each slice). A lost response leaves an active batch. The next
  poll without `ackBatch` replays it (`:508-529`). If the batch expires, the rows re-claim normally. A worker killed
  mid-wait leaves `waiting = true` only until `expires_at` = acquire + wait + 6 s.
- **Admission is correct under concurrency.** `claimWaitingSlot` (`:672-702`) takes
  `pg_advisory_xact_lock(hashtext('h0-wait-admission'), hashtext('deployment'))` and then runs one `UPDATE` whose count
  subquery gets its snapshot after the lock is granted (READ COMMITTED). A second worker therefore sees the first
  worker's committed `waiting = true`. Only `claimWaitingSlot` and `releaseLock` take the advisory lock. Each runs in its
  own short transaction and takes no other lock first, so there is no lock-order cycle. `releaseLock` runs from
  `finally` on every path after `held` is set. A failed first transaction rolls back its own lock row.
- **No transaction is open during the wait.** `sleep` (`:127-131`) is a `setTimeout` between separate `begin` blocks.
  `h0Database()` is `max: 1`, and no `begin` is nested inside another, so the one-connection pool cannot deadlock itself.
- **The wire rules hold.** The bearer is read from the header only. `h0BearerInQuery` refuses query credentials before
  auth. `wait` is an integer from 0 to 50. The poll returns at most 10: own leases (limit 10), then
  `claimAgentInbox(limit: 10 - own)`. The ack body is the required set `signal_id, lease_id, listener_instance_id,
  outcome, last_error_code` plus omittable `surfaced`, and it is passed to `ackAgentDelivery`. The ack wire has no
  ordinal field, as the lead ruled.
- **Migration style matches the existing tables.** Owner is `swarm_admin`. RLS is enabled. `REVOKE ALL` from `PUBLIC`,
  `anon` and `authenticated`. `swarm_command` gets `SELECT, INSERT, UPDATE` with a `swarm_command_all` policy. Guard
  functions use `SET search_path = pg_catalog` and have `EXECUTE` revoked. This is the same shape as
  `20260916000002_agent_join_attempts.sql`.
- **Both new test files are reached by a script.** `tests/p1-cli/h0-poll-contract.test.ts` is matched by the
  `test:p1-cli` glob, and `tests/p1-server/h0-poll-ack.test.ts` by the `test:p1-server` glob. `check:edge` already
  names `supabase/functions/h0/index.ts`.

## Findings

### F1: RIGOUR. The in-repo "mutation" test cannot fail, so it is not a control.
`tests/p1-cli/h0-poll-contract.test.ts:159-171`
```ts
const mutated = command.replace(needle, "false && await principalIsH0Seat(");
...
const bodyAfterRemoval = { error: "delivery_unavailable" };
assert.throws(() => { assert.equal(bodyAfterRemoval.error, H0_SEAT_CLAIM_REFUSED); });
```
The test is named "removing the fence makes the refusal assertion fail". The mutated source is never executed. The
final assertion compares a hard-coded literal to a different constant, so it passes whatever the edge does. Line 165
also pins exact whitespace (`"h0SeatClaimRefusal(\n          false && ..."`), so a reformat fails it while a behaviour
change does not. This is the "a negative result must reach the path it claims to test" failure. The real control is the
manual mutation recorded in LANE.md (§Mutation), run against `tests/p1-server/h0-poll-ack.test.ts:372-425`. That run
is sound: HTTP 200 plus a delivery where 403 is required. The in-repo test should be deleted or renamed so it does not
claim to be a mutation control.

### F2: RIGOUR. The admission test does not show that the advisory lock is needed.
`tests/p1-server/h0-poll-ack.test.ts:632-740`, `poll-ack.ts:645-652`.
The recorded mutation (`H0_MAX_CONCURRENT_WAITS = 2`) shows that the test checks the constant. The test starts two
`fetch` calls, and they reach `claimWaitingSlot` milliseconds apart. Nothing forces the two count-then-set
transactions to overlap. With `lockWaitAdmission` removed, the test would very probably still pass. LANE.md says "Two
workers cannot both pass", and by reading the code that is true (see "What holds"). But no test measures it. A control
would call `claimWaitingSlot` directly from two connections held open together, or remove the advisory lock and show a
failure.

### F3: RIGOUR. The wait deadline is not tied to the lock's expiry, and the per-slice hold check does not lock the row.
`poll-ack.ts:792`, `:816-823`
```ts
const deadline = Date.now() + parsed.body.wait * 1_000;   // measured AFTER the first tx and admission
...
SELECT 1 AS held FROM swarm.h0_poll_locks WHERE ... AND holder = ... AND expires_at > statement_timestamp()
```
`expires_at` was set in the first transaction to acquire + wait + 6 s. The loop deadline starts later, after the rest
of the first transaction (claim and hydrate, with `lock_timeout` 5 s) and after the admission transaction. If those
take more than about 5 s combined, the loop runs past `expires_at`. Two things then follow:
- (a) The last slice answers 409 `h0_poll_in_progress` with "This poll's lock ended", although that poll did nothing
  wrong.
- (b) While the loop overruns, the admission count (`other.expires_at > statement_timestamp()`) no longer counts it.
  A second waiter can be admitted, so `H0_MAX_CONCURRENT_WAITS` is briefly exceeded.
The `still` check is a plain `SELECT`, not `FOR SHARE`. So in the window at expiry, a concurrent poll for the same seat
can take the lock between this check and `collect`. Both then return the same active batch. Both use the same
listener id, so no delivery is double-acked. This needs DB stalls over 5 s and a second poll from the seat itself, so it
is RIGOUR, not PRODUCTION. Fix: set `deadline = min(start + wait, lockExpiry - cleanup)`, and use
`FOR SHARE` or a conditional check in the slice.

### F4: RIGOUR. An abandoned request keeps the only deployment-wide slot for the full wait.
`poll-ack.ts:793-840` never reads `request.signal`. If the client disconnects (for example, an agent tool timeout
shorter than 50 s), the handler still waits for up to 50 s. During that time, the one `H0_MAX_CONCURRENT_WAITS` slot is
held for every workspace, and that seat's own retry gets 409 `h0_poll_in_progress`. No data is lost: a message claimed
by the orphaned poll goes into the active batch and is replayed. The fix is cheap: check `request.signal.aborted` in
the loop and before each slice.

### F5: RIGOUR. The long-poll is a 1 Hz database poll, and the physical connection stays open during the wait.
`poll-ack.ts:66` (`WAIT_SLICE_MS = 1_000`), `:102-107` (`idle_timeout: 3`).
A 50 s wait runs up to 50 transactions. Each one repeats auth (`loadAgentCredential`), `closeExpired`, and
`claimAgentInbox`, which does `SELECT ... FOR UPDATE` on the principal row and 3 `UPDATE`s. The pool connection is
released between slices, as LANE.md says. But slices are 1 s apart and `idle_timeout` is 3 s, so the server-side
connection never closes during a wait. The file header says "The pool connection is back in the pool before the wait
starts". That is true of the pool, not of the Postgres connection. It is acceptable at a cap of 1, but LANE.md should
say it precisely. The spec's pool concern was about a pinned connection.

### F6: RIGOUR. `h0_poll_in_progress` has two meanings.
`poll-ack.ts:784-787` and `:824-830` reuse `H0_POLL_IN_PROGRESS` for "this poll's own lock ended". The code's
documented meaning (`parse.ts:28-30`) is "another poll for this seat is running; wait for it". The client action is
the same (poll again), so nothing breaks. But a code is supposed to classify the condition, and here it covers two.

### F7: RIGOUR. An active batch whose rows are all acked is replayed with no deliveries and no wait.
`poll-ack.ts:516-529` returns `kind: "ready"` with `deliveries: []` and the old `batchId` when every lease in the active
batch has been acked one by one. Because it is `ready`, it does not wait and has no `retryAfterSeconds`. An agent that
acks every message but leaves out `ackBatch` gets an immediate empty answer on each poll until the batch's
`expires_at` (up to the 15-minute lease). The document tells agents to send `ackBatch`, so a compliant agent does not
hit this. Closing an active batch that has no live leases would remove the case.

### F8: RIGOUR. A stale `ackBatch` after a lost response is refused, and the agent must recover.
`poll-ack.ts:469-476`. Sequence: poll(`ackBatch=B1`) closes B1 and commits B2, then the response is lost. The retry
sends the same body. `current` is B2, not B1, so the server returns 409 `h0_ack_batch_mismatch`. The stored state is
correct and nothing is lost. The message says to omit `ackBatch`, and that returns B2. So recovery works, but a plain
retry of the same request fails. Treating an `ackBatch` that names this seat's already-closed batch as done, and then
replaying the active batch, would make the retry idempotent. No test covers this case.

### F9: RIGOUR. The h0 poll accepts non-H0 seats.
`poll-ack.ts:210-254` (`authenticate`) does not call `principalIsH0Seat`. So any valid agent token can claim through
`/h0/poll` with a new listener id. This is not a regression: non-H0 seats can already run several command-edge
consumers at once, and nothing locks them to one. But the fence exists to give one consumer per seat, and this path is
open in the other direction without a statement in LANE.md. Either refuse non-H0 seats here (the helper already exists)
or record the choice.

### F10: RIGOUR. The CLI reports the new refusal as credential loss.
`src/listener/runtime.ts:465-469` treats every 403 on claim as `isDeliveryCredentialLoss`. `agent-channel.ts:333-334`
rethrows 403. A CLI listener started with an H0 token therefore stops and reports a credential problem, although the
credential is valid. It stops, so it does not flood the refusal audit row. The spec leaves the client treatment of the
refusal to the lane. No client names `h0_seat_uses_poll`. Worth one line in LANE.md.

### F11: RIGOUR. `h0_poll_batches` has no retention.
`20260922000001_h0_poll_lock_and_batch.sql:117-121`: the guard refuses `DELETE`. Every non-empty poll inserts one row
and nothing removes it. The table grows without limit, and a later purge must work around the trigger. This is not
urgent, but it should be listed under "Not established".

## Not established by this review

- I ran no test, no `deno check`, and no `check:tests`. The pass claims in LANE.md are the Maker's, not mine.
- The edge-runtime semantics behind Fold 1 are not established. The box runs `--policy per_worker --max-parallelism 4`
  with a 150 s worker wall clock (`compose.yaml:13-17`, `README.md:23`). I did not confirm that a waiting request
  occupies one of the four workers exclusively, and not merely one isolate that also serves other h0 requests. I also
  did not confirm what the 150 s wall clock does to a poll that starts near a worker's end of life. If the runtime kills
  it, `finally` does not run and the slot frees only at `expires_at`. That is safe but untested.
- Not established: deploy path. `apply-h0-upgrade.sh` does not apply the two new migrations (LANE.md says so). The live
  box does not yet pass database env to h0.
- Not established: whether a command-edge rate bucket applies to h0 poll and ack. LANE.md says it does not. Each poll's
  `releaseLock` also takes the global advisory lock, even for `wait: 0`.

VERDICT: PASS
