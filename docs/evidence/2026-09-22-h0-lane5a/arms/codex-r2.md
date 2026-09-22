- **PRODUCTION — `deploy/supabase-stack/migrate/apply-h0-upgrade.sh:24-25,90-93`:** The box upgrade applies `000001` and `000002`, but not the new retention migration `000003`. That migration alone adds the purge and daily cron job (`20260922000003_h0_poll_batch_retention.sql:100-163`). On the box, the original guard still refuses every batch delete, so closed batches grow without a purge. The post-upgrade verifier also expects the old cron set (`verify-post-upgrade-counts.sh:21,67`); adding `000003` needs a matching verifier change.

- **PRODUCTION — `supabase/functions/h0/poll-ack.ts:762-778,907-939`:** A wait slice checks lock ownership with a plain `SELECT`, then calls `collect` without holding that lock. If the slice stalls past lock expiry, a new poll can take the seat lock while the old poll continues. Both can read the same active batch (`:537-557`) and return its delivery to two consumers. The new lock-row deadline limits the wait, but does not close this gap inside a slow slice.

- **RIGOUR — `deploy/supabase-stack/migrate/apply-h0-upgrade.sh:55-56,86-99`:** The skip path treats two poll *table names* as a complete poll schema: `poll_count` is a count, then the script skips to `verify-h0-catalog.sql`. That verifier checks the join catalog, not the poll columns, grants, index, or guards. A malformed poll schema can therefore pass the claimed catalog check.

- **RIGOUR — `tests/p1-server/h0-poll-ack.test.ts:1000-1007`:** The `batchImmutable` test helper branches on `error.message.includes("SWARM_H0_POLL_BATCH_IMMUTABLE")`. That makes prose part of its classifier, contrary to D-053. The database code also supplies `55000`; the test should use a stable assigned code if it needs to distinguish this guard.

The five pure poll tests and twelve local Python unit tests passed. I ran no database or production test.

VERDICT: FAIL
