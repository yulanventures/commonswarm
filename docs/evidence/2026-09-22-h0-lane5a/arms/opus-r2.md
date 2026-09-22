# D-036 Checker review, round 2 (Claude Opus arm): H0 lane 5a at 3dc812c9

Scope: `git diff a103a512...3dc812c9` and `git diff bbee0033...3dc812c9` (13 files in fold 2), LANE.md with Fold 1
and Fold 2, the round-1 reviews (codex-r1.md FAIL, opus-r1.md PASS), and the box main service
(`deploy/edge-runtime/main/index.ts`, `router.ts`). I used read-only git only. I ran no test, no database, no Docker,
and no network command.

## Fold-2 claims, checked on the code

1. **Abort ends the wait and frees the slot (handler level): holds.** `poll-ack.ts:133-160` adds `H0ClientAbort`,
   `sleep(ms, signal)` (clears the timer and rejects on abort), and `throwIfAborted`. The handler checks the signal
   before admission (`:868`), before each slice (`:880`), and in each sleep (`:944`). A throw leaves through the
   `finally` at `:960-967`, which calls `releaseLock`. The test at `h0-poll-ack.test.ts:760` can fail: without the
   signal, the 8 s wait would outlast the 2000 ms race and `settled` would be `"timeout"`. Whether a client disconnect
   reaches `request.signal` in production is a different question. See F1.
2. **apply-h0-upgrade.sh applies 000001 and 000002 after the 09-16 pair: holds.** The pinned hashes match the
   files at 3dc812c9. I computed them with `git show 3dc812c9:<file> | shasum -a 256`: `d151e09f…289a` and
   `3d57cf0a…4992`. The branches are at `apply-h0-upgrade.sh:86-97`. There are three branches: all four tables
   present (skip), none present (apply four), and join tables present with poll tables absent (apply two). Any other
   state fails. An orphan poll guard with no poll table is refused (`:66-72`). The SQL runs in one transaction with
   the verifier (`:99`). `run-db-tool.sh` mounts all four files. `verify-post-upgrade-counts.sh:49-56` adds the poll
   pair at zero, or keeps both, and fails when only one is present. The RUNBOOK wording is exact: "checks the join
   catalog". See F3 and F4.
3. **The deadline is read from the lock row on each slice: holds.** `readWaitHold` (`poll-ack.ts:750-788`) uses
   `clock_timestamp()` against `acquired_at + wait` and `expires_at`, and gives `LEAST(...)` as the remaining time.
   The loop has no local clock now. `expires_at` = acquire + wait + 6 s, so the wait bound comes at least 6 s before
   the lock can be taken over. My round-1 F3 (overrun past `expires_at`, the cap briefly exceeded, a race in the
   unlocked check) is closed. The test at `:907` can fail: the old code would wait the full 20 s.
4. **`h0_poll_lock_ended` is a separate code: holds.** `parse.ts:32-36`. It is used for admission `"lost"`
   (`poll-ack.ts:870-874`) and for a slice whose lock has ended (`:913-915`). `h0_poll_in_progress` now has only
   the meaning "another poll holds the lock". Round-1 F6 is closed.
5. **Retention migration 000003: correct as SQL.** Details are in the next section.
6. **The circular mutation test is deleted: holds.** `h0-poll-contract.test.ts` no longer has it. The fence proof
   is the server test plus the manual mutation that LANE.md records.
7. **The advisory-lock test can fail: holds.** `h0-poll-ack.test.ts:1156` holds
   `pg_advisory_xact_lock(hashtext('h0-wait-admission'), hashtext('deployment'))` on another connection. It then
   requires `waiting = 0` and an unsettled poll after 800 ms. If `lockWaitAdmission` is removed, `waiting` becomes 1
   and the test fails, as LANE.md records. The poll reaches `claimWaitingSlot`, because the lock row is committed
   first. This shows that the admission step takes the lock. My round-1 F2 is closed to the level the lead asked for.
8. **Stale ackBatch message: holds.** `parse.ts` says "Poll again without ackBatch." The test at `:979` follows the
   real lost-response sequence: B1, then ackBatch=B1 gives B2 with the same unacked lease, then a retry with B1
   gives 409, and a plain poll replays B2.
9. **LANE.md records F5, F7, F9 and hands F10 to the listener lane: holds** (LANE.md "Poll and ack", Fold 2 item 9).

## Retention migration (20260922000003)

- **The guard is correct.** `h0_poll_batches_guard` is replaced. The UPDATE rules are the same as in 000001
  (lines 132-159 of 000001 against lines 40-67 of 000003). DELETE is allowed only when `status = 'closed'`,
  `closed_at IS NOT NULL`, and `closed_at < statement_timestamp() - make_interval(days => retention_days())`.
  Active batches and recent closed batches still raise `SWARM_H0_POLL_BATCH_IMMUTABLE`.
- **Grants and owner follow the existing style.** The three functions are owned by `swarm_admin` with
  `REVOKE ALL ... FROM PUBLIC`. The two SECURITY DEFINER functions use `SET search_path = swarm, pg_catalog`. This is
  the same shape as `purge_expired_idempotency_keys` (`20260906000050`). The guard is not SECURITY DEFINER. Its call
  to `swarm.h0_poll_batch_retention_days()` therefore runs as the deleting role. The only deleter is the purge, which
  runs as `swarm_admin` and owns the function. `swarm_command` has no DELETE grant.
- **Cron.** `'swarm-purge-h0-poll-batches'` runs at `'29 4 * * *'`. That time does not collide with the existing
  jobs. `cron.schedule` with a name is an upsert, as the p1_schema comment says. The job runs as the role that
  applies the migration, as the existing jobs do. The migration can run twice: it uses `ON CONFLICT`,
  `CREATE OR REPLACE`, and a named schedule.
- **It cannot delete a batch that is still referenced.** No foreign key points at `h0_poll_batches`. The only
  reference is an agent's `ackBatch`. Active batches are never deleted. A closed batch lists leases that ended at
  least 2 days earlier (the batch `expires_at` is `min(leased_until)`, at most the 15-minute lease), and
  `ownLeaseRefs` reads `signal_deliveries`, not the batch. A purge therefore loses no delivery. A very late
  `ackBatch` for a purged batch changes from a silent accept (`poll-ack.ts:506-522`) to 409 `h0_ack_batch_unknown`
  with "Omit ackBatch to poll". The agent can recover from that.
- **What leaving 000003 out of apply-h0-upgrade.sh means for a box upgrade.** A box upgraded by the script gets the
  000001 guard, which refuses every DELETE, and it gets no purge job. `h0_poll_batches` grows by one row for each
  non-empty poll, and nothing can remove rows without disabling the trigger. Retention exists only where the whole
  migration folder runs (local reset). The box needs a separate step to apply 000003, and nobody has written that
  step. That step adds a cron job, so it must run after `verify-post-upgrade-counts.sh`, because that check requires
  the source cron set to stay the same. The file is safe to apply later on its own: it is idempotent and replaces
  only the guard body. LANE.md "Not established" records the gap. This is not urgent at a cap of one waiting poll.
  But the server tests measure a guard (000003) that the box path does not install. See F2.

## Abort path: loss or double hand-off

An abort cannot lose or double-hand a delivery. The postgres transaction is not bound to the signal, so a slice that
has started commits in full. If that slice claimed rows, `current.kind` is `"ready"`. The loop breaks, and the 200
goes to a closed socket. The rows are in the active batch under the seat's single `listener_instance_id`. The next
poll gets 409 `h0_poll_in_progress` until `releaseLock` runs, then replays that batch. If the abort comes before or
between slices, nothing was claimed, and `finally` releases the lock and the slot.

## Findings

### F1: RIGOUR. It is not shown that a client disconnect reaches `request.signal` on the box, and the lane's own evidence suggests that it does not.
`deploy/edge-runtime/main/index.ts:91`: `return await worker.fetch(forwarded);` (no second argument).
LANE.md Fold 2 item 1: "The local gateway does not abort the edge request, so the test calls
`handleH0PollRequest` with a Request whose signal it aborts."
The test at `h0-poll-ack.test.ts:760` runs the handler in a separate `deno run` with an `AbortController`. It proves
that the handler honours a signal. It does not prove that Caddy → main → user worker delivers one. The lane measured
that the local `functions serve` stack does not deliver it. `rewriteFunctionRequest` (`router.ts:132-139`) copies
the signal onto `forwarded`. But `EdgeRuntime.userWorkers.create(...).fetch` is called without options. From memory,
not checked offline: the upstream main examples pass `{ signal }` as the second argument of `worker.fetch`. If the box
behaves like the local stack, then in production an abandoned poll still holds the only slot until `acquired_at + wait`.
That is the round-1 Codex behaviour that the lead ruled must be fixed. The effect is bounded and loses no data, so I
keep the severity I gave it in round 1. But the fold's claim ("a client abort now ends the wait") is shown only for
the handler, and LANE.md "Not established" does not list the box gateway. Next step: either read the edge-runtime
v1.73.13 source for `UserWorker.fetch` abort propagation, or run the pinned edge-runtime image locally with this main
service, abort a waiting poll, and read `waiting`. Record the result in LANE.md either way.

### F2: RIGOUR. The retention guard in the tests is not the guard the box upgrade installs.
`20260922000003_h0_poll_batch_retention.sql:14`: "apply-h0-upgrade.sh does not run this file."
`h0-poll-ack.test.ts:1010` passes against a local reset, which runs 000003. On the box path, the table has the
000001 guard (`20260922000001:127-130`, every DELETE raised) and no cron job. LANE.md records this. This finding only
adds what the upgrade means (see the section above): unbounded growth until an unwritten step applies 000003 after the
post-upgrade count check. Also list who owns that step.

### F3: RIGOUR. The upgrade branch that a live box takes has no test.
`apply-h0-upgrade.sh:91-93`: `elif [[ "$join_count" -eq 2 && "$poll_count" -eq 0 ]]; then … "\i $file3"…"\i $file4"`.
`test-h0-upgrade.py:94-101` tests only "absent → apply four", then the skip. A box that already has the 09-16 pair
takes the "join present, poll absent" branch. No fixture sets that state up (apply only file1 and file2, then run the
helper). LANE.md also records no fold-2 run of `npm run test:h0-upgrade:local` (Docker) or `npm run test:h0-counts`.
The fold-2 edit to 000001 (`CREATE UNIQUE INDEX IF NOT EXISTS agent_principals_principal_workspace`, with the comment
"so the foreign keys below still apply when this file runs on its own") suggests that one of these was run. No exit
code is recorded.

### F4: RIGOUR. No catalog verifier checks the poll tables.
`apply-h0-upgrade.sh:99` runs `verify-h0-catalog.sql`, whose expected JSON names only the join tables, their guards,
the dependency indexes, and the views. On the skip branch (`:86`), a recovery snapshot whose poll tables are malformed
passes: for example `waiting` is missing, the guard is disabled, or an ACL is wrong. The edge would then fail at the
first poll. The apply branch is deterministic because the SHAs are pinned, so the risk is limited to the skip path.
The RUNBOOK states this exactly ("checks the join catalog"). It is a gap in proof, not a false claim.

### F5: RIGOUR. The abort test can send the handler to a database that is not loopback.
`h0-poll-ack.test.ts:865`: `env: { ...process.env, SUPABASE_DB_URL: local.DB_URL, … }`.
`poll-ack.ts` `h0Database()`: `Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL")`.
If the runner's shell exports `SWARM_DATABASE_URL`, and `SWARM_DATABASE_TLS_CA_B64` with it, the handler under test
connects there, while the script's own `sql` reads the local database. The file header says "This file refuses any
non-loopback URL". The loopback check (`:83`) covers only `supabase status`. In practice the test would fail (its
tokens would not authenticate there), but it would first open a connection to that host. Fix: set
`SWARM_DATABASE_URL: local.DB_URL` and delete `SWARM_DATABASE_TLS_CA_B64` in that `env`.

### F6: RIGOUR. A client abort is logged as a poll failure and answered with 500.
`h0/index.ts:42-45`: `handleH0PollRequest(request).catch(() => { console.error("h0 poll failed"); return h0VerbFailure(); })`.
`H0ClientAbort` is a named class, but no code checks it. Every abandoned wait therefore writes "h0 poll failed". This
causes no wrong behaviour (the client is gone) and D-053 is clean, because nothing branches on `.message`. But the log
cannot tell an abort from a real fault. An `instanceof H0ClientAbort` check in that catch would separate the two.

### F7: RIGOUR (minor). Two small items in the migrations.
- `20260922000001:9-14`: the fold-2 index statement sits inside the header comment block and splits it. Only the
  comment layout is affected.
- `20260922000003:124`: `ORDER BY closed_at` with `WHERE status = 'closed'` has no supporting index, so each purge
  iteration is a sequential scan. This is acceptable at today's volume.

## Unchanged from round 1 and still true

The fence is at the single command-edge claim branch, before replay and before the `claimAgentInbox` call. Fold 2
does not touch `supabase/functions/command/`. The three listener paths (`session-receiver.ts`, `agent-channel.ts`,
`listener/runtime.ts`) reach it only through `DeliveryCommandClient.claimAgentInbox`. The ack still passes the fence.
The per-seat lock and the one-active-batch index stop two consumers from sharing a seat. Expired batches re-claim
through `claimAgentInbox`. No transaction or pool checkout is held during the sleep. The postgres connection stays
open (`idle_timeout: 3`), and LANE.md now says so. Both server and CLI test files are reached by the
`test:p1-server` / `test:p1-cli` globs. `check:edge` names `h0/index.ts`. The fold-2 code has no `error.message`
branch. The test predicate `batchImmutable` checks SQLSTATE `55000` and the raised name, and it is test-only.

## Not established by this review

- I ran no test, no `deno check`, no `check:tests`, no Docker gate, and no `test:h0-counts`. The pass counts in
  LANE.md (15 tests, exit 0) are the Maker's figures.
- I did not establish whether edge-runtime v1.73.13 propagates a client abort to a user worker (F1).
- I did not establish the role that owns the cron job on the box, or when 000003 will reach the box (F2).
- Worker behaviour under `--max-parallelism 4` and the 150 s worker wall clock is as I recorded in round 1: not
  established.

The data paths are correct, and each round-1 finding was either fixed in the code or recorded honestly. What remains
are gaps in proof about the box path (F1 to F4) and small test and logging defects (F5 to F7). None of them makes a
user lose or double-receive a delivery.

VERDICT: PASS
