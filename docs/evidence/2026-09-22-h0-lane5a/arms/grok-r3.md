I will review lane 5a at `f1ba1fb3` only. No file changes, no database, no production hosts. I start by reading the lane record, the spec, and the two diffs.Round 2 failed on a stall between the lock check and the claim, and on the box upgrade skipping the retention migration. I am reading the fold-3 diff against those two points.The seat-lock `FOR UPDATE` deadlocks with a second poll of the same seat. That second poll is the path that should return `409`. One of the two requests fails with `500`.

**PRODUCTION — `supabase/functions/h0/poll-ack.ts:906`, `supabase/functions/h0/poll-ack.ts:759`, `supabase/functions/h0/poll-ack.ts:941`, `supabase/functions/_shared/agent-auth.ts:223`, `supabase/functions/command/durable-delivery.ts:205`, `supabase/functions/h0/poll-ack.ts:660`.** A waiting slice and a second poll of the same seat lock the same two rows in opposite orders. Postgres aborts one transaction with `40P01`. `supabase/functions/h0/index.ts:43` turns that into HTTP `500`. The slice rolls back, so a delivery is not handed out twice. The long-poll still dies, or the second poll gets `500` where the seat lock is supposed to answer `409 h0_poll_in_progress`.

The slice does this, in one transaction:

```906:947:supabase/functions/h0/poll-ack.ts
            const session = await sessionOrRefusal(tx, auth.seat, request);
            // ...
            const hold = await readWaitHold(
              tx,
              auth.seat,
              opened.holder,
              parsed.body.wait,
            );
            // ...
            return {
              collected: await collect(
                tx,
                auth.seat,
                opened.listenerInstanceId,
                null,
                session.session,
              ),
```

`sessionOrRefusal` takes `FOR SHARE` on the principal before the seat row is locked:

```223:228:supabase/functions/_shared/agent-auth.ts
  const principals = await tx<{ managed_at: Date | string | null }[]>`
    SELECT managed_at
    FROM swarm.agent_principals
    WHERE principal_id = ${args.principalId}::uuid
    FOR SHARE
  `;
```

`readWaitHold` then holds the seat row through `collect`:

```759:764:supabase/functions/h0/poll-ack.ts
  const locked = await tx<{ holder: string }[]>`
    SELECT holder::text
    FROM swarm.h0_poll_locks
    WHERE workspace_id = ${seat.workspaceId}::uuid
      AND principal_id = ${seat.principalId}::uuid
    FOR UPDATE
  `;
```

On an empty inbox, `collect` calls `claimAgentInbox`, which upgrades that same principal to `FOR UPDATE`:

```205:210:supabase/functions/command/durable-delivery.ts
  const principalRows = await tx<{ principal_id: string; revoked_at: Date | null }[]>`
    SELECT principal_id, revoked_at
    FROM swarm.agent_principals
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND principal_id = ${args.recipientPrincipalId}::uuid
    FOR UPDATE
  `;
```

The second poll uses the other order. It also takes `FOR SHARE` on the principal first (`poll-ack.ts:842`), then `acquireLock` waits on the seat row. `INSERT ... ON CONFLICT DO UPDATE` locks that row even when the expiry predicate fails:

```660:666:supabase/functions/h0/poll-ack.ts
    ON CONFLICT (workspace_id, principal_id) DO UPDATE
    SET
      holder = EXCLUDED.holder,
      acquired_at = statement_timestamp(),
      expires_at = EXCLUDED.expires_at,
      waiting = false
    WHERE poll_lock.expires_at <= statement_timestamp()
```

Cycle: the slice holds the seat row and waits to upgrade the principal; the second poll holds `FOR SHARE` on the principal and waits for the seat row. The same order exists in the opening transaction at `poll-ack.ts:842` then `poll-ack.ts:849` then `poll-ack.ts:859`. Fold 3 repeats it on every wait slice. The stalled-slice test expires the row while another session holds it, so the old slice returns before `collect` and never runs this interleaving.

The admission lock does not close a cycle. `claimWaitingSlot` and `releaseLock` (`poll-ack.ts:674` and `poll-ack.ts:683`) take `pg_advisory_xact_lock` and then the seat row. The slice never takes that advisory lock. `ackBatch` updates `h0_poll_batches` only after the seat row is already held (`poll-ack.ts:473`). `POST ack` locks a delivery row and does not lock `h0_poll_locks`.

**RIGOUR — `deploy/supabase-stack/migrate/verify-h0-poll-catalog.sql:72`.** The pinned migration hashes match the files at `f1ba1fb3` (`000001` `beb6bf0f…`, `000003` `ba059d9d…`). The five function-body hashes match the `AS $$` bodies, including the leading newline Postgres stores. The verifier still accepts a wrong partial index. `pg_get_expr(...) LIKE '%status%active%'` also matches `status <> 'active'`, so the skip path can pass with no one-active-batch rule. The waiting index check (`verify-h0-poll-catalog.sql:83`) does not read columns or the `WHERE waiting` predicate. Check constraints, foreign keys, the trigger function binding, and the policy expressions are not read. The Docker mutation list drops the index; it does not replace the predicate.

The other Fold 3 claims hold in the source. The `1 s` sleep is after `begin` returns (`poll-ack.ts:950` then `poll-ack.ts:955`), so the seat-row lock is not held across the sleep. A client abort throws `H0ClientAbort` only from that sleep or from `throwIfAborted`, both while the slice result is still empty, and `finally` calls `releaseLock` before `index.ts:44` answers `204`. No test reads that `204`. `worker.fetch(forwarded)` at `deploy/edge-runtime/main/index.ts:91` still passes no signal. `LANE.md` records that box abort propagation is not established. The batch-guard test classifies SQLSTATE `55000` only. I did not re-run the lead gates, Docker, or a database.

VERDICT: FAIL
