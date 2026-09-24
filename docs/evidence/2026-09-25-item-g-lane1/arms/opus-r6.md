# Opus round 6: exact review of `git diff c61ae4a7..ec44cc95` (item G lane 1)

Arm: exact review, Anthropic family. Worktree: detached at `ec44cc95844ba9b84703d6cd1eb91e7c6b76c3eb`.
Scope: the five files in the diff (migration index, catalog proof clause, catalog test case, LANE.md, cursor task doc).
No file in the worktree changed. No production host was contacted. Every SQL probe ran in a transaction that
rolled back, and every probe printed `leftover: 0`. I did not lock `swarm.signal_deliveries` while the lead's
server suite ran. I ran the one probe that touches that table only after `r6-server.log` finished (260/260).

Probes: `scratchpad/itemG/opus-r6-probes/`.

## Check 1: the index

**Columns and predicate: correct for both lookups.** Migration `:59-61`:

```sql
CREATE INDEX signal_deliveries_unclaimed_observed
  ON swarm.signal_deliveries (workspace_id, recipient_agent_principal_id)
  WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL;
```

- Known-seat EXISTS (`:93-98`): equality on `workspace_id` and `recipient_agent_principal_id`, plus the three
  predicate conjuncts exactly. `acked_at >= cutoff` stays a filter. The first index row satisfies it, because every
  unclaimed observed row is after the release.
- Heal NOT EXISTS (`:102-116`): the same two equalities and the same three conjuncts (`:115-116`). The order tuple
  is on `later_signal`, so no index on this table can serve it. The per-seat scan stays, as LANE `:158` says.
- Measured on the migrated local stack (`view-cost-1.out`, `view-cost-2.out`, same shape as my r5 probe):
  `Index Scan using signal_deliveries_unclaimed_observed on signal_deliveries observed (actual rows=1 loops=1000)`
  and `... on signal_deliveries later (actual rows=245 loops=1000)`. Execution: 262 ms and 282 ms. Without the index, r5 measured 0.7-1.3 s and the lead measured 1599 ms.

**No row matches the index at release.** The pre-migration check9 (`20260731000001_signal_deliveries.sql:69-74`) with check3
(`(acked_at IS NULL) = (ack_outcome IS NULL)`) forbids an `observed` row without the lease pair. The constraint was
created valid.

**Lock class and cost.** The box wraps each migration in one `BEGIN … COMMIT` with `lock_timeout = '5s'` and
`statement_timeout = '5min'` (`deploy/RELEASE-TO-BOX.md:916-918`). The `ALTER TABLE` statements already hold
`AccessExclusiveLock`. `CREATE INDEX` adds `ShareLock`, which the same transaction already covers. `build-cost.out`
uses a 1,000,000-row scratch copy (153 MB heap, no matching row). Locks held: AccessExclusive, AccessShare,
RowExclusive, Share, ShareUpdateExclusive. `VALIDATE` took 60 ms. The index build took 39 ms, and 41 ms warm. The
index is 8 kB. The build adds one heap scan to the exclusive window. It does not queue a new lock.

**Other writers and plans.**
- Inserts: new rows have `ack_outcome` NULL, so they add no index entry. In `insert-ab.out` (alternating, 20k rows),
  times with the index were 48 and 52 ms, and times without it were 72 and 45 ms. That is noise.
- HOT updates: each write that changes `ack_outcome` or `last_lease_*` also changes `acked_at`, which the existing
  indexes already cover. See `durable-delivery.ts:753-760`, `:800-809`, `:878-888` and `command/index.ts:11480-11510`.
  So HOT loses nothing new.
- Plans: a partial index serves only a query whose WHERE implies its predicate. A grep of `supabase/` and `src/`
  for `last_lease_id IS NULL` finds only the migrations. No other plan can change.

Check 1 holds.

## Check 2: the catalog clause

- The installed catalog returns `catalog_ok=t` (`catalog-installed.out`, full proof, read-only transaction).
- The test case `managed-delivery.test.ts:964-968` drops only the index. It shares the loop with the `installed` case,
  which is expected to be `true`, so it discriminates. The lead's `r6-managed.log` passed 23/23, and this test is one
  of the 23.
- `catalog-clause.out` evaluates the new clause on a scratch table (no lock on `swarm.signal_deliveries`):
  - The clause returns `f` for these indexes: no index, columns reversed, and a predicate without `last_leased_by IS NULL`.
  - The clause returns `t` for the migration's exact index.
  - The clause also returns `t` for three wrong indexes (see F2).

## Check 3: the section-6 read-edge probe (fails; see F1)

## Check 4: LANE.md claims added in ec44cc95

These are true: "none at release"; "built inside the migration's existing exclusive window"; the catalog-test
sentence; the growth sentence; "rolled back, no leftovers" (each `idx-probe/*.out` ends with `leftover: 0`); the
superseded marks on H2 (`:79`), I4 (`:108`) and K1 (`:127`); the heading hashes (all three are in
`git log 4d4cb3f7..ec44cc95`); and the cursor-task text (`src/cloud/signals.ts:1113-1123` still sends `gte` and
`created_at.asc,id.asc`). F1 and F3 cover the false or imprecise claims.

## Findings

### F1. PRODUCTION (release window): the section-6 read-edge probe is refused with 400, and it names a note that does not exist yet

`docs/evidence/2026-09-25-item-g-lane1/LANE.md:16`:

> one loopback `POST http://127.0.0.1:9000/functions/v1/read` with `resource: "signals"`, `inbox: true`,
> `after_created_at: null`, `after_id: null`, `include_stale: false`, and `limit: 50` must return 200 and contain
> the seeded note's id.

The read edge's validator accepts only an exact key set. See `supabase/functions/read/index.ts:204-212`
(`exactKeys`: same length, same keys) and `:297-311`:

```ts
!exactKeys(body, ["resource", "workspace_id", "inbox", "about", "kind", "since",
  ...(modernShape ? ["in_reply_to"] : []), ...channelKeys,
  ...(cursorMode ? ["after_created_at", "after_id"] : []), "limit", "include_stale"]) ||
```

The probe omits `workspace_id`, `about`, `kind` and `since`. I measured this on the local served read edge
(loopback `127.0.0.1:54321`), with a well-formed unknown agent token (`swm_agt_` + 43 × `A`). See
`read-edge-shape.out`:

```
lane-literal -> 400 {"error":"invalid_request"}
lane-plus-workspace -> 400 {"error":"invalid_request"}
full-shape -> 401 {"error":"unauthenticated"}
```

The full shape passes the validator and reaches the token lookup, so the control can discriminate. The body as LANE
states it cannot return 200.

The sequence is also wrong. The probe must "contain the seeded note's id", but the next sentence creates that note:
"Afterward a dedicated test seat must send one unclaimed observed ACK, then receive a new directed note". Section 6
(`RELEASE-TO-BOX.md:1276-1291`) creates the seed only after the ACK. The probe must run after the second note is
posted and before the functional proof.

Impact: section 6 Verify runs after the migration and both edges are live. A literal run fails. "a functional probe
fails" is a stop condition (`RELEASE-TO-BOX.md:1752-1753`), so the window stops on a working release. Also,
`LANE.md:161` says "Box order below now supplies one", but the box order is above (`:16`).

Fix: send the full shape (the shape `src/cloud/signals.ts:1180-1200` sends):
`{"resource":"signals","workspace_id":"<seat workspace>","inbox":true,"about":null,"kind":null,"since":null,"in_reply_to":null,"after_created_at":null,"after_id":null,"limit":50,"include_stale":false}`.
Send it with `Authorization: Bearer <seat token>` from a root-owned curl config. Run it after the second note is
posted. Also say that a fresh seat's inbox must hold fewer than 50 live directed signals. A null cursor pages
oldest-first (`read/index.ts:90-91`), so the seed, which is the newest signal, is not on page 1 if there are more.

### F2. RIGOUR: the catalog index clause accepts three wrong indexes

`deploy/release-proofs/item-g/20260925000001-catalog.sql:76-85` matches substrings with `LIKE`. In
`catalog-clause.out` the clause returned `t` for each of these:

```
... WHERE ((ack_outcome = 'observed'::text) AND (last_lease_id IS NULL) AND (last_leased_by IS NULL) AND (acked_at IS NULL))   -- empty forever; no plan can use it
... WHERE ((ack_outcome = 'observed'::text) OR ((last_lease_id IS NULL) AND (last_leased_by IS NULL)))
CREATE UNIQUE INDEX ... (workspace_id, recipient_agent_principal_id) WHERE (...)                                             -- would refuse a seat's second observed ACK
```

The brief asks for `f` with a wrong predicate. The clause gives `f` only when a whole conjunct or a column is wrong.
The only producer is the fixed migration text, so this is a rigour gap, not a live risk. An exact comparison closes
it: `pg_get_indexdef(i.oid) = 'CREATE INDEX signal_deliveries_unclaimed_observed ON swarm.signal_deliveries USING btree (workspace_id, recipient_agent_principal_id) WHERE ((ack_outcome = ''observed''::text) AND (last_lease_id IS NULL) AND (last_leased_by IS NULL))'`.
PostgreSQL 17.6 prints that string. The same string with `opus_r6_idx` on `public.opus_r6_sd` is in `catalog-clause.out`.

### F3. RIGOUR: LANE's post-migration timing depends on the plan, and "each using the index" is only half true

`LANE.md:158`: "on a stack reset with the migration's index, three runs took 61, 50 and 51 ms, each using the index."

- In `idx-probe/migrated-2.out` and `migrated-3.out`, only the known-seat lookup used the index. The heal read
  `Seq Scan on signal_deliveries later (actual rows=49000 loops=1)` into a hash anti join. Only `migrated-1.out`
  had both lookups on the index.
- On the same migrated stack, my two runs (`view-cost-1.out`, `view-cost-2.out`) chose the nested-loop plan, with
  both lookups on the index, and took 262 ms and 282 ms. So the migrated cost at this shape is 50-280 ms, depending
  on plan choice. It is not 50-61 ms.
- Two cited figures have no saved output: the lead's 69 ms no-index run and the 263 ms index run. Only `base.out`
  (1599 ms) and `idx.out` (280 ms) exist.
- The cited probe directory `scratchpad/itemG/idx-probe/` is gitignored and local to this session. AGENTS.md says
  that evidence which must survive goes in `docs/evidence/`.

Nothing here changes the ruling. The index removes the 0.7-1.6 s pkey scan in every plan measured. It is a claim
precision gap.

## Not established by me

- `npm test`, `test:p1-cli` and the site suite at `ec44cc95`. `src/` did not change in this diff.
- The served server suite. I relied on the lead's `r6-managed.log` (23/23) and `r6-server.log` (260/260).
- A DROP-INDEX run of the full catalog proof by me. I avoided an AccessExclusive lock on the shared table. The
  lead's served test covers that case, and my scratch-table clause probe covers the clause logic.
- Production row counts, box index-build time, and box plan choice.
- Any box state.

F1 is a measured false claim in the one probe this commit adds for the box. Check 3 fails, and a literal run would
stop a production window after the migration is applied. The fix is one sentence.

VERDICT: FAIL
