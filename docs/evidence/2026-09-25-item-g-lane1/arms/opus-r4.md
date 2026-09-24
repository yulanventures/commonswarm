# Item G lane 1: exact review (Anthropic arm), round 4

Subject: `lane/item-g-lane1` at `a3736201`. Base `4d4cb3f7`. The fold-4 diff is `b178c470..a3736201`.
Worktree `scratchpad/arms-g4` is read-only. I built and mutated only in `git archive` copies under
`scratchpad/itemG/opus-r4-probes/{tree,base}`, with `node_modules` symlinked.

What I did not do: change a tracked file, commit, contact a production host, or run a cswarm command. I did not run
`db:reset`, `db:stop`, or `test:p1-server`. Every SQL probe ran against the local stack (`supabase_db_cloud-swarm`) in
a transaction that was rolled back. After the probes, 0 `opus-r4-%` principals remained. The view still has the fold-4
text. The cutoff row is unchanged (`2026-09-24 19:48:33.393+00`).

Probes: `opus-r4-probes/k1-matrix.sql` (output in `k1-matrix.out`), `catalog-real.sql`, `catalog-control.sql`, `k2-mut.sh`
(logs in `mut-*.log`).

| Check | Result |
|---|---|
| 1. K1 order and kind | The rule is correct, and it is check's own order. Two holes in check's cursor remain (see F5), and a false cutoff claim remains (see F2). |
| 1. Fixture faithful? | It amplifies a real inversion. The inversion is reachable at posting-transaction scale. The minutes-long gap is not reachable. The rule is not over-constrained (see F4). |
| 2. K2 | PASS. Measured with mutations. |
| 3. I1-I4 | PASS. Measured on the local DB. |
| 4. Controls fail on revert | K2 PASS (measured). K1 order and kind: the lead measured them at `a3736201`. The catalog proof has **no** control (see F1). |
| 5. LANE.md and box order | **FAIL.** Section 5 of the box release stops after the migration is applied (F1). LANE.md is stale about the lead's fixture fix (F3). |

---

## Findings

### F1. PRODUCTION: the box catalog proof returns `f` on the fold-4 migration, so the release stops after the migration is applied

`deploy/release-proofs/item-g/20260925000001-catalog.sql:54` still pins the fold-2 predicate:

```sql
      AND pg_get_viewdef(v.oid) LIKE '%later.enqueued_at > d.enqueued_at%'
```

Fold 4 (`cca60866`) removed that predicate from `swarm.wake_path_eligible_deliveries`
(`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:94-107` now reads
`AND (later_signal.created_at, later_signal.id) > (s.created_at, s.id)`).

I measured this on the local stack, which carries the `a3736201` migration after the lead's reset. The proof ran read-only, with `\gset` replaced by `;`:

```
db_has_fold4_view | db_has_old_text  ->  t|f
catalog proof (real file)            ->  f
control: line 54 LIKE replaced by '%later_signal.created_at%'  ->  t
```

Line 54 is therefore the only reason for the `f`. In `deploy/RELEASE-TO-BOX.md` section 5, Verify runs this file after
`release_psql --file /run/commonswarm-release-apply.sql` has applied the migration. It then runs `test "$CATALOG_AFTER" = t`
(line 1001). The subshell exits nonzero with the ledger at 1. The box then has the migration live and the edge unreleased,
and the release is halted by a proof failure. The order in LANE.md:16 ("apply migration `20260925000001`, then release the command edge")
cannot be completed as written.

Why no gate caught it: no test runs `20260925000001-catalog.sql`. The server test "wake catalog validates the lease-free observed shape…"
(`tests/p1-server/managed-delivery.test.ts:844`) uses its own inline catalog query. The functional-proof test (`:912`) runs only
`-functional.sql`. Folds 1-3 ran the catalog proof by hand (LANE.md:101, 114). Fold 4 changed the view and did not rerun it.

Fix: pin the fold-4 predicate at line 54, for example `'%(later_signal.created_at, later_signal.id) > (s.created_at, s.id)%'`
plus `'%later_signal.kind = ANY%'`, using the exact `pg_get_viewdef` spelling. Add a server test that pipes the catalog file through the
same `docker exec … psql -v ON_ERROR_STOP=1` harness as `runProof` and requires `t`. Its mutation control is to reintroduce the enqueue-order clause in a
rolled-back view and require `f`.

### F2. RIGOUR: the release cutoff is load-bearing, but the migration comment and LANE I2 say it is redundant, and no test controls it

`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:64-67`:

```sql
-- One private eligible-row source feeds both the roster and receipts. Its
-- release cutoff is redundant by construction: a known seat has an observed
-- ACK after the cutoff, and that later observation excludes older mail. Keep
-- the cutoff as an explicit release guard; no independent test can reach it.
```

LANE.md:106 (I2) repeats this: "It is redundant by construction … No independent cutoff mutation test is claimed."

This claim does not hold. The seat's post-cutoff ACK can be for an OLD signal. A seat whose cursor is behind at release
presents its pre-cutoff backlog oldest first and ACKs that first page. The next page is pre-cutoff mail that is later in check order, so
no observed row heals it. Measured (probe C4, rolled back):

```
C4 pre-cutoff V after the only observed W -> V eligible (expect f)                 => false
C4 known-seat EXISTS holds (expect t)                                              => true
C4 V hidden by the later-observed rule? (expect f: only the cutoff excludes V)     => false
C4-MUT view without `d.enqueued_at >= cutoff`: V eligible (expect t)               => true
```

Without line 78, V (enqueued 150 minutes before) would mark an actively reading seat "stale · no session check in 3 minutes" right after
release. The predicate is correct. But no test fails when it is deleted, and `catalog.sql:48` (`'%wake_path_release%'`) also
matches the observed-seat EXISTS, so it does not pin line 78 either. Fix: correct the comment and LANE I2, and add a server test with this
shape: post W and V, set the cutoff after both, ACK W through the command edge, and require that V is absent. Then run the drop-cutoff mutation.

### F3. RIGOUR: LANE.md does not record `a3736201`, so its fold-4 claims are stale

LANE.md:125 says: "These server tests are written but await the lead's local stack, so mutation outcomes are reasoned from the
assertions, not measured here." LANE.md:141 says the served server tests "remain unestablished". At `05eac1ac`, the Maker's fixtures
could not pass at all:
- The late-recipient `INSERT INTO swarm.signal_recipients` raises 55000 from `signal_recipients_same_transaction`.
- The non-ask/note fixture inserted a second delivery row.
- The box-proof member-gate mutation's `.replace("AND swarm.is_member(...)")` became a no-op once fold 3 made the gate a `WHERE`.

So at that SHA, the reasoned claim "Reverting the tuple comparison fails the inverted-order assertion" was vacuous. The lead's fix is real.
`r4-managed.log` shows 20/20. `r4-mut-order.log` shows only "check order wins…" failing. `r4-mut-kind.log` shows only "an observed
non-ask/note delivery…" failing. Those results live in scratchpad logs and one commit message, not in the artifact. The clause "removing the heal fails the existing assertion" is still
unmeasured at this SHA. I agree with it by reading `managed-delivery.test.ts:677-692`, and my C5 probe shows the NOT EXISTS is the only thing
that excludes E. Per AGENTS.md ("Corrections go in the artifact"), add a Fold-4 addendum that names `a3736201`, the three fixture defects, 20/20,
and the two measured mutations. Also add a line saying Fold 4 supersedes Fold 2's H2 "later-enqueued" wording (LANE.md:79).

### F4. RIGOUR: the two new fixtures say they model "historical" rows that production cannot hold

- `managed-delivery.test.ts:706`: "Today's trigger refuses a late recipient; this rolled-back fixture models a historical row."
  `swarm.signal_recipients` and `signal_recipients_same_transaction` are created in the same migration
  (`20260905000010_signal_recipients.sql:142`). No committed row ever gained a recipient in a later transaction.
- `:755`: "A malformed historical row can exist…" That row also breaks the deferred position-0 consistency trigger, which the
  rollback never reaches. The only writer of an unclaimed `observed` ACK is the edge branch that refuses non-ask/note
  (`supabase/functions/command/durable-delivery.ts:736-750`).

**Answer to the brief's question.** The inversion is reachable, but only within one posting transaction. `created_at` is the
`INSERT INTO swarm.signals` statement time (`command/index.ts:8759`). Each additional recipient's delivery gets `enqueued_at =
statement_timestamp()` of its own later `INSERT INTO swarm.signal_recipients` (`command/index.ts:8810-8822`, `enqueued_at DEFAULT
statement_timestamp()` in `20260731000001_signal_deliveries.sql:19`). A concurrent post that lands inside those milliseconds reverses the two orders.
The fixture stretches that gap to minutes, so it is an amplified model, not a historical row. It is a valid control of the comparison.

The rule is **not** over-constrained. `(created_at, id)` is exactly the order the read edge returns rows in
(`read/index.ts:925-929`) and the order check accepts rows in (`compareSignalCursor`). Probe C2 confirms the tie-break: a higher id
observed at the same microsecond heals the lower id, and the reverse does not. That matches the in-page order. Change both comments to say
"amplified in-transaction inversion" and "defence in depth".

### F5. RIGOUR: check's cursor has a second hole, a commit-order skip, and the follow-up task names only the millisecond skip

`docs/design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md:14-15` says: "Its later-observed heal is safe only when check's cursor has
shown every earlier signal in that order." That is true. Probe C3 confirms the filed millisecond skip: the read edge's `after(A)` excludes
B, and a later observed C hides B from the view.

The same class of hole also comes from commit order. The posting transaction stamps `created_at` at the signal INSERT and keeps
running (recipient rows, attachments) until it commits. A check that reads a later-created signal that committed earlier moves its cursor past
the uncommitted one. The earlier row is then never presented, and the next observed ACK hides it from both the roster and the receipt. The
receipt then falls back to the true "Not yet delivered…" sentence (`src/cloud/receipts.ts:179-183`), so no false claim appears. But the
row is lost to `cswarm check`, and no surface shows it. This is reasoned from code. I did not measure it, because a probe would need committed rows. It is not a
regression from this lane. Add it to the follow-up task so the fix to the check cursor covers both holes.

---

## What holds (measured)

**K1** (probe `k1-matrix.sql`, one rolled-back transaction, cutoff moved to one hour before the probe):

```
C1 O(created earlier, enqueued later, via signal_recipients) observed; X later pending -> X eligible   => true
C2a tie: higher id observed, lower id pending -> lower hidden                                         => false (hidden)
C2b tie: lower id observed, higher id pending -> higher eligible                                      => true
C3 ms-cursor-skipped B hidden by later observed C (filed task)                                        => false (hidden)
C5 later recipient-1-only ask observed heals earlier E                                                => false (hidden)
```

These cases ran with the same-transaction trigger enabled. My probe posts the signal and its recipients in one transaction, which the trigger allows.

- **Different session:** every host session of a profile shares one `check.json` (`src/cloud/agent-check.ts:135-139`). A second profile starts with
  `cursor: null` and pages from the oldest live inbox row. So a later observed ACK from any reader of the principal means that reader's cursor passed
  the earlier row, except for the F5 and millisecond holes.
- **Session-bound rows:** these are claimed rows, and the view excludes any row with lease history (lines 76-77).
- **Broadcasts:** a broadcast has no delivery row.
- **Deferred MCP commit:** it queues only the visible prefix (`agent-check.ts:324-330`).
- **Direct commit:** it queues only what was presented (`:257-258`).

**K2**: `queuedRetries` (`agent-check.ts:81-85`) filters the map in four places: on read (`:163`), on every persist (`:274`), on the direct commit (`:334-335`), and on the deferred commit (`:326-330`).
Backoff is `min(60 s, 250 ms × 2^min(n−1, 8))`, and the pre-request `next_at` is bounded by the deadline plus 60 s. The ACK runs after `present`, or
after the MCP write, and every error is swallowed (`:332`, `:340`, `:350`). Mutation table, run on the 4 retry tests in `agent-onboarding.test.ts`:

```
control (no-op edit)             4/4 pass
helper returns whole map         3 fail: capped-queue, age-cap, typed-403 (pinned)
persist site only                2 fail: age-cap, typed-403
read site only / direct only / deferred only   4/4 pass
```

The cap test pins the helper. Each single call site is covered by the others, and the next read always prunes, so this is defence in depth, not a gap.
The LANE claim "replacing the prune helper with the old whole-map copy failed" is true.

**I1-I4** (same rolled-back transaction):

```
I1 agent sender, agent-token path (no claims): addressed/bit => true/true
I1 nonmember JWT receipt => null ; nonmember roster rows => 0 ; owner roster rows => 1
I3 private view SELECT for authenticated/anon/swarm_read/swarm_command => f,f,f,f
I3 detail view SELECT for authenticated/anon => f,f
```

- **I4:** the functional-proof test covers missing, unknown, revoked, owner-left, observed, expired, competing, later-observed,
  view-omitted, no-member-gate, and anonymous-gate. The lead's run passed it (20/20).
- **`a3736201`'s member-gate fix:** it asserts that the mutation finds `WHERE swarm.is_member(d.workspace_id, auth.uid())` exactly once. That guard is correct. The earlier
  no-op `.replace` would have passed nothing.
- **The competitor backdate in `removeCompetitor`:** this is required under K1, because an observed competitor created after the seed would heal the seed and fail the proof for the wrong reason.

**Box order, apart from F1:** section 6 posts note 1, sends the unclaimed observed ACK, then posts note 2. Note 2 is created after note 1, so K1
does not heal it, and the functional proof's positive path holds.

**Gates, run on the archive copies with a temporary HOME:**
- `npm run build`: exit 0.
- Focused `delivery-client`, `delivery-receipts`, `agent-onboarding`, `mcp-stdio`, `receipt`, `hook-routing`: **173/173**, exit 0.
- `citation-drift`, `h0-agent-document`, `h0-verbs`: 32/32.
- `npm test`: 967 tests, 12 failed. Every failing name also fails on base `4d4cb3f7` in the same archive setup (962 tests, 13 failed).
  The causes are host-ACP timing tests and tests that need a `.git`. The lane adds no failure.

**Not established by me:**
- The served server suite. I relied on the lead's `r4-*.log`.
- `test:p1-cli` in full, and the site suite.
- Query cost of the new signals join. The r3 plan measurement (36 ms) was on the fold-2 predicate.
- The commit-order skip in F5, which I did not measure.
- Any box or production state.

VERDICT: FAIL
