I'll review this lane read-only: the fence, lock order, release proofs, and whether the new tests actually reach those paths. No files change, and nothing talks to a host or a database.The lane is at `6f4395c8`. Next I’ll read the lock paths, the catalog proofs, and the round-3 failures those folds say they closed.The round-3 deadlock and the weak catalog check are fixed. One release proof can still say the schema is complete when the one-active-batch index is on the wrong columns.

**RIGOUR** — `deploy/release-proofs/h0/20260922000001-catalog.sql:54-56`. Migration `20260922000001` is complete only when `h0_poll_batches_one_active` is unique on `(workspace_id, principal_id)`. This proof checks the name, that the index is unique and valid, and the predicate. It does not check the columns. A unique index of that name on `(batch_id)` with `WHERE status = 'active'` makes every other term true, so `catalog_ok` is `t`. Section 5 then refuses to apply the file and asks for a ledger backfill. Dropping the index does return `f`. The primary-key checks in this same file use the full index definition. `20260922000002` and `20260922000003` do too.

```54:56:deploy/release-proofs/h0/20260922000001-catalog.sql
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_batches_one_active')
    AND i.indrelid=to_regclass('swarm.h0_poll_batches') AND i.indisunique AND i.indisvalid
    AND pg_get_expr(i.indpred,i.indrelid) = '(status = ''active''::text)')
```

```106:108:supabase/migrations/20260922000001_h0_poll_lock_and_batch.sql
CREATE UNIQUE INDEX h0_poll_batches_one_active
  ON swarm.h0_poll_batches (workspace_id, principal_id)
  WHERE status = 'active';
```

The exact verifier already requires the full definition, including those columns (`deploy/supabase-stack/migrate/verify-h0-poll-catalog.sql:160`). The section 5 proof does not.

The other round-4 checks hold:

- `FOR NO KEY UPDATE` still conflicts with `FOR NO KEY UPDATE`, `FOR SHARE`, and `FOR UPDATE`. Claims serialize with each other. A revoke or other principal change is an `UPDATE` (key columns such as `wake_id` take `FOR UPDATE`). Those wait. `FOR KEY SHARE` from a signal insert does not wait. That is the lock-mode change. It does not let two claims take the same delivery. Writers: claim and poll `SELECT … FOR NO KEY UPDATE` (`durable-delivery.ts:211`, `poll-ack.ts:329`); session proof `FOR SHARE` (`agent-auth.ts:227`); registration replay `FOR UPDATE OF p` (`command/index.ts:6126`); enable, disable, recover, and acquire `FOR UPDATE` (`command/index.ts:11550`, `11777`); model, `revoked_at`, and `managed_at` updates take `FOR NO KEY UPDATE` or stronger (`command/index.ts:4294`, `4357`, `6819`, `11593`); `rotate_wake_id` updates `wake_id` and takes `FOR UPDATE`. Inserts create a new row.
- Poll work locks the principal, then the session, then the seat row, then batches and deliveries (`poll-ack.ts:865-889` and `930-973`). Admission and release take the advisory lock, then the seat row, and do not lock the principal (`poll-ack.ts:706-741`). No path locks the seat row and then the principal, or the principal after that advisory lock.
- A non-H0 listener claim still goes through `claimAgentInbox`. The only change in that function is the principal lock mode. `FOR SHARE` still blocks it. The H0 fence is only on `claim_agent_inbox`, before idempotency replay (`command/index.ts:9297-9321`). Ack is not refused. The listener files post to that command branch.
- Each catalog proof is one boolean `catalog_ok` row and ends with `\gset`. Before its migration the value is `f`. After a full apply it is `t`. The dropped-index case is `f`. The functional files are read-only. `40P01` and `40001` return 503 `h0_transaction_retryable` (`poll-ack.ts:133-137`). The exact index comparison still rejects `WHERE status <> 'active'`. Postgres 17 deparse in that verifier matches the forms that gate compares (`CHECK` with `ANY`, `BEFORE DELETE OR UPDATE`, `WHERE waiting`, `WHERE (status = 'active'::text)`, ACL letter `m`). This review did not run the database.

VERDICT: FAIL
