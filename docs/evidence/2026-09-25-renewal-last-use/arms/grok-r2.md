I'll review the renewal last-use lane as a read-only check: the fold from `e1cfd84c` to `d36e6d65`, then the whole lane against `5d603b8e`. No files will be changed.The fold replaces the `GREATEST` clamp with a full stale-use skip. Next I’ll compare both writers with their prior definitions and the trigger that rejected the partial update.The installed bodies match the catalog proof. Next I’ll exercise the stale-use skip and the proof’s negative cases inside a transaction that rolls back.The stale-use skip is correct, the successor still spends once, and the migration is safe to apply. One residual equal-timestamp case remains, and it fails closed.

## Check 1 — stale skip, spend, and the trigger

Both edges call `swarm.record_renewal_grant_use` inside `READ COMMITTED` (`supabase/functions/read/index.ts:445`, `supabase/functions/command/index.ts:8902`), passing the token’s run device and `NULL` for the source (`read/index.ts:534-539`, `command/index.ts:10929-10935`). After a lock wait, PostgreSQL rechecks the `WHERE` on the committed row. `statement_timestamp()` stays at the outer statement: a rolled-back probe showed it unchanged across an inner `SELECT` after `pg_sleep`, and a trigger saw the same timestamp as its firing statement.

```35:37:supabase/migrations/20260925000002_renewal_last_use_monotonic.sql
    AND NOT grant_row.suspension_active
    AND (grant_row.last_used_at IS NULL
         OR grant_row.last_used_at <= statement_timestamp());
```

A row whose `last_used_at` is already later than this statement no longer matches, so device, source, and `new_host_at` stay as the later use wrote them. On a fresh row the same statement still records the use. A later statement with another device and source advances `last_used_at`, device, source, and `new_host_at`.

The fence holds `FOR UPDATE` before either write (`20260925000002_renewal_last_use_monotonic.sql:139-142` in the September 4 body, unchanged). Spend is its own update:

```186:201:supabase/migrations/20260925000002_renewal_last_use_monotonic.sql
  UPDATE swarm.renewal_grants
  SET successors_used = successors_used + 1
  WHERE renewal_grant_id = grant_row.renewal_grant_id;

  UPDATE swarm.renewal_grants
  SET last_used_at = statement_timestamp(),
      last_used_device_id = run_device,
      ...
  WHERE renewal_grant_id = grant_row.renewal_grant_id
    AND (last_used_at IS NULL OR last_used_at <= statement_timestamp());
```

The second assignment list does not touch `successors_used`. A rolled-back fixture measured a fresh successor at `successors_used = 1` with its own device and timestamp, and a stale successor at `successors_used = 1` with the newer device, source, `new_host_at`, and future `last_used_at` left in place. Reinstalling the September 4 fence raised `SWARM_RENEWAL_LAST_USE_REWOUND` and left the counter unchanged (`1->1`). Reinstalling the round-1 `GREATEST` fence raised `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` and also left the counter unchanged.

The replaced statements assign `last_used_at`, `last_used_device_id`, `last_used_from`, `new_host_at`, and `successors_used` only. The no-rewind trigger still rejects an older `last_used_at`, a device or source change at an unchanged timestamp, and any change to an existing `new_host_at` (`20260904000001_standing_grant_resume.sql:165-180`). The skip path writes none of those. The apply path sets `last_used_at` to this statement’s timestamp only when the row’s value is null or earlier, and the `new_host_at` `CASE` keeps a value already stored. `successors_used` moves by `+1`. `suspended_at`, `resumed_at`, `revoked_at`, `successors_stranded`, and the immutable grant columns are absent from both assignment lists.

Live catalog: the only functions whose source mentions `last_used_at` are the two writers, `prepare_renewal_grant` (read), `renewal_grants_spend_or_revoke_only` (the check), and the two `swarm_read` projections.

## Check 2 — prior definitions

Against `20260904000001_standing_grant_resume.sql`, the recorder differs only by the predicate above. The fence differs only by splitting the old single update into the spend update and the conditional use update. Signature, `SECURITY DEFINER`, `search_path`, owner, `REVOKE`/`GRANT`, and the fence comment match that definition.

## Check 3 — tests

`tests/p1-server/renewal-last-use.test.ts:135-148` locks one grant, starts A, and requires A’s backend to be in `wait_event_type = 'Lock'`, blocked by that locker (`pg_blocking_pids`), with a granted `RowExclusiveLock` on `swarm.renewal_grants`, before B records a later use. A’s statement therefore starts first. A uses another device and source (`:138-139`). On the fixed body A succeeds and B’s timestamp, device, source, and null `new_host_at` remain (`:150-158`). The same shape for a successor uses `RowShareLock` because the fence’s `SELECT … FOR UPDATE` takes `ROW SHARE` (`:192`), then requires `successors_used = 1` and B’s fields (`:208-212`). An ordinary row wait is on the locking transaction, so that blocker pid is the grant row.

The served test is a member read in the principal’s own workspace, which is the statement at `read/index.ts:534`. A trigger error becomes HTTP 500 (`read/index.ts:383-390`, `:965`). The test requires the blocked `record_renewal_grant_use`, then HTTP 200 and B’s timestamp (`renewal-last-use.test.ts:255-275`). That is the production same-device, null-source race. The device and source case is the SQL test.

I did not re-run `test:p1-server`. In a rolled-back transaction, the September 4 recorder raised `SWARM_RENEWAL_LAST_USE_REWOUND` and the `GREATEST` recorder raised `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` against an already-later use with another device and source. That is the row state the recheck sees.

## Check 4 — catalog proof

Installed proof result: `t`. Digests `2b6cb7cab75148ab3555fb69a485e86b` and `5f1454a676423a8c96ff1afbfea788a9`. Recorder: security definer, owner `swarm_admin`, `search_path=swarm, pg_catalog`, execute for `swarm_command` and `swarm_read`. Fence: not security definer, owner `swarm_admin`, `search_path=pg_catalog`, execute for the owner only. The no-rewind trigger is enabled (`tgenabled = O`).

Inside savepoints that were rolled back, the proof returned `f` for the `GREATEST` recorder, the September 4 recorder, the `GREATEST` fence, a public `search_path`, security invoker, `EXECUTE` revoked from `swarm_read`, `EXECUTE` granted to `anon`, extra `EXECUTE` on the fence, a fence owner other than `swarm_admin`, and the no-rewind trigger disabled. Restoring each savepoint returned `t`. Reapplying the migration text in the same transaction left `t`. After `ROLLBACK`, both digests were unchanged and the probe rows were gone.

## Check 5 — applying it on the box

The file is `CREATE OR REPLACE` of the same signatures, plus owner, `REVOKE`, `GRANT`, and `COMMENT`. No table rewrite and no data update. While that transaction was open, the heavyweight locks on database objects were `AccessExclusiveLock` on `pg_proc` 19347 (`record_renewal_grant_use`) and 19129 (`agent_tokens_successor_fence`), and `ShareUpdateExclusiveLock` on the fence from the comment. `swarm.renewal_grants` was not locked. `20260925000001` changes `signal_deliveries` only; this function text stands on the September 4 definitions.

## Findings

1. **RIGOUR** — `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql:36-37` and `:201`. The predicate uses `<=`, so an equal timestamp still enters the update. A rolled-back probe with `last_used_at = statement_timestamp()` raised `55000 SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` for another device and source, and succeeded for the same device with a null source, leaving device and source unchanged. Both edges send that same device and null source. A strictly earlier statement, which is the overlapping-read race, skips.

2. **RIGOUR** — `docs/evidence/2026-09-25-renewal-last-use/LANE.md:14` and `:21` and `:56`. The committed record still says the `GREATEST` server mutation is reasoned until it is run, and that the Fold 1 migration has not been applied and its races and catalog proof are unmeasured. The installed catalog is the Fold 1 bodies, and the lead’s measurement at this SHA is `test:p1-server` 264/264, with the round-1 migration failing the two field races.

VERDICT: PASS
