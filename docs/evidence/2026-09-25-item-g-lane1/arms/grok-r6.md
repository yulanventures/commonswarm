I'll review only the `c61ae4a7..ec44cc95` change as a read-only lane check: the unclaimed-observed index, the catalog proof, and the new LANE.md claims.The diff is small. Next I’ll check the index against both lookups, the catalog proof, and the read-edge probe.The probe text and the index proof are the parts that can fail the release. I’ll measure both on the local stack, inside a transaction that rolls back.The index and the catalog drop-case are sound. The section 6 read probe is not a request the read edge will accept, and at the step where the box order runs it the seeded note does not exist yet.

## What holds

The partial index matches both lookups in `swarm.wake_path_eligible_deliveries`. The known-seat `EXISTS` (`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:93-98`) and the heal `NOT EXISTS` (`:102-116`) both equality-match `(workspace_id, recipient_agent_principal_id)` and state `ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL`. With sequential scans disabled, PostgreSQL 17.6 uses `signal_deliveries_unclaimed_observed` for both. `acked_at >= cutoff` stays a residual filter on the known-seat lookup.

No row can match that predicate before this migration commits. The previous `signal_deliveries_check9` (`supabase/migrations/20260731000001_signal_deliveries.sql:69-74`) requires a lease pair on every acked row other than `expired` and `failed_terminal`, and `(acked_at IS NULL) = (ack_outcome IS NULL)` (`:48`) ties `observed` to a non-null `acked_at`. The build is inside the migration transaction that already holds `AccessExclusiveLock` from `DROP`/`ADD` of that constraint. `CREATE INDEX` adds `ShareLock` (measured: `AccessExclusiveLock` is present after `CREATE TABLE`, and `ShareLock` appears only after `CREATE INDEX`). On a 200,000-row heap with zero matching rows the build took 12 ms and left an 8192-byte index. The box wrapper's `statement_timeout` is 5 minutes (`deploy/RELEASE-TO-BOX.md:917-918`). Other indexes on this table are disjoint (`unacked` is `acked_at IS NULL`; this predicate implies `acked_at IS NOT NULL`), so they do not lose rows to this index.

The installed catalog proof returns `t`. After `DROP INDEX` in the same transaction it returns `f`, and the transaction rolled back with the original index restored. `tests/p1-server/managed-delivery.test.ts:964-968` is that drop, expecting `false`. A predicate that omits `last_leased_by IS NULL`, and an index with the columns reversed, also return `f`.

These new `LANE.md` statements match the code: the H2, I4, and K1 superseded marks; the heading hashes `a3736201`, `d3d49fcd`, and `c61ae4a7`; "none at release"; "built inside the migration's existing exclusive window"; and the human PostgREST path (`src/cloud/signals.ts:1113-1123` still sends `created_at=gte…` and `order=created_at.asc,id.asc`). A raw read does not ACK: `record_renewal_grant_use` updates `swarm.renewal_grants` only.

## Findings

### F1. PRODUCTION — the section 6 read probe is rejected, and it names a note that is created later

`docs/evidence/2026-09-25-item-g-lane1/LANE.md:16`:

> one loopback `POST http://127.0.0.1:9000/functions/v1/read` with `resource: "signals"`, `inbox: true`, `after_created_at: null`, `after_id: null`, `include_stale: false`, and `limit: 50` must return 200 and contain the seeded note's id.

The read edge accepts only an exact key set (`supabase/functions/read/index.ts:204-212`, `:298-311`). Cursor keys turn cursor mode on, and the body must also carry `workspace_id`, `about`, `kind`, and `since`. The written set omits all four. On the local read edge at `127.0.0.1:54321`, with `Authorization: Bearer` set to an unknown `swm_agt_` token (so parsing runs):

- the literal body returned `400 {"error":"invalid_request"}`
- the same body plus `workspace_id` returned `400 {"error":"invalid_request"}`
- the full key set (`about`, `kind`, and `since` null) returned `401 {"error":"unauthenticated"}`, which is past the validator

A seat token does not change the 400. The same paragraph then says the note is created afterward ("Afterward a dedicated test seat must … receive a new directed note left unchecked"). Section 6 posts that seed only after the observed ACK (`deploy/RELEASE-TO-BOX.md:1276-1291`). A literal run cannot return 200, and it cannot contain that id. A failed functional probe stops the window (`deploy/RELEASE-TO-BOX.md:1752-1753`), after the migration has already committed.

`LANE.md:161` says "Box order below now supplies one." The probe is in the box-order paragraph at line 16, above that row.

Even with a complete body, a null cursor pages oldest-first (`read/index.ts:820`, `:928-932`) with `limit: 50`. The seed is the newest note, so a seat that already has 50 live signals will not show it on that page.

### F2. RIGOUR — the new catalog clause accepts some wrong indexes

`deploy/release-proofs/item-g/20260925000001-catalog.sql:76-85` matches `pg_get_indexdef` with `LIKE`. On a scratch table, same transaction, rolled back:

| Index | Clause |
|---|---|
| absent | `f` |
| migration predicate | `t` |
| columns reversed, or `last_leased_by IS NULL` omitted | `f` |
| `… AND acked_at IS NULL` (empty for every legal `observed` row; neither lookup implies it) | `t` |
| `ack_outcome = 'observed' OR (last_lease_id IS NULL AND last_leased_by IS NULL)` | `t` |
| `CREATE UNIQUE INDEX` on the same columns and predicate (a second unclaimed observed ACK for one seat would fail) | `t` |

The live proof on the installed catalog is `t`, and the drop case is `f`, so `managed-delivery.test.ts:964-968` measures what it claims. The shipped index is not unique and does not have those predicates. The clause would still pass them.

The reset-stack timings in `LANE.md:158` match the saved probe for 1599 ms, 280 ms, and 61/50/51 ms. In `migrated-2` and `migrated-3` only the known-seat lookup used the index; the heal side was a sequential scan. The cited 69 ms and 263 ms runs are not in `scratchpad/itemG/idx-probe/`.

VERDICT: FAIL
