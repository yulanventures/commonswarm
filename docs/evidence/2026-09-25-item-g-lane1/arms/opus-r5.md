# Item G lane 1: exact review (Anthropic arm), round 5

Subject: `lane/item-g-lane1` at `c61ae4a7` (detached worktree `scratchpad/arms-g4`, HEAD verified). Base `4d4cb3f7`.
The round-5 diff is `a3736201..c61ae4a7` (`d3d49fcd`, `c61ae4a7`). In that range, `src/`, `site/`, and the pure
tests are unchanged (`git diff --stat a3736201..c61ae4a7 -- src site tests/p1-cli tests/*.ts` is empty). So the
round-4 K2 and pure-gate measurements still apply to this SHA.

What I did not do: change a tracked file, commit, contact a production host, run a cswarm command, or run
`db:reset`, `db:stop`, or `test:p1-server`. Every SQL probe ran on the local stack (`supabase_db_cloud-swarm`,
PostgreSQL 17.6, the same major and minor as the box pin in `deploy/supabase-stack/VERSIONS.md`) in a transaction
that was rolled back. After each probe, 0 `opus-r5-%` principals remained. The cutoff row was unchanged
(`2026-09-24 20:17:23.525+00` before and after). The installed view still has the millisecond heal.

Probes are in `scratchpad/itemG/opus-r5-probes/`: `catalog-real.sql`, `catalog-mutations.sql`,
`catalog-old-proof.sql`, `k1-matrix.sql`, `plan.sql`, `view-cost.sql`, `view-cost-compare.sql`, with an `.out` file for
each.

## Round-4 findings: status at c61ae4a7

| Finding | Status | Evidence |
|---|---|---|
| Opus R4-F1 PRODUCTION (catalog pinned fold-2 text) | **FIXED** | The proof returns `t` on the installed view. It returns `f` on the a3736201 proof text and on six view mutations (below). |
| Opus R4-F2 (cutoff called redundant) | **FIXED** | The comment is corrected (`migration:64-66`). LANE I2 has a strike-through and a CORRECTED marker. The new server test and my C4 probe both show that the cutoff alone excludes the backlog. |
| Opus R4-F3 (LANE stale about a3736201) | **FIXED, with gaps** | The "Lead fold" section records the fixtures, 20/20, and the measured mutations. H2 (`LANE.md:79`) still does not say it is superseded (see F3). |
| Opus R4-F4 (fixture comments said "historical") | **FIXED** | `managed-delivery.test.ts:705-707` and `:756-757` now say "amplified" and "production cannot hold this row". Both statements are correct. |
| Opus R4-F5 (commit-order skip not filed) | **FIXED** | `CHECK-CURSOR-MILLISECOND-TASK.md:21-25` adds the skip and marks it OPEN. |
| Grok R4-1 PRODUCTION (catalog) | **FIXED** | This is the same finding as R4-F1. |
| Grok R4-2 PRODUCTION (read edge paged in microseconds, cursor in milliseconds) | **FIXED** | See check 1. |

## Check 1: one check order everywhere

The order is `(date_trunc('milliseconds', created_at), id)` in each of these places:

- **Read edge ORDER BY** (`supabase/functions/read/index.ts:928-932`):
  `CASE WHEN ${orderAsc} THEN date_trunc('milliseconds', s.created_at) END ASC, … s.id`.
- **Read edge after-cursor** (`:914-923`): uses the same truncation and then `s.id >`. This line did not change.
- **Wire cursor:** postgres.js parses `timestamptz` with `new Date(x)`. V8 truncates the microseconds, so it does not round them. I measured this: `new Date("2026-09-24 12:00:00.999900+00")` gives `…00.999Z`. The JSON cursor is therefore the same truncated millisecond.
- **Client comparator** (`src/cloud/signals.ts:613-622`): `Date.parse` (milliseconds), then a string compare of lowercase UUIDs. For hex text, this equals PostgreSQL's byte order for `uuid`. The callers are:
  - `agentSignalPage` (`:1269-1280`), which sorts with `sortSignals` and takes `nextCursor` from the last raw row. That row is now the last row in `(ms, id)` order, not the last in microsecond order.
  - check's `check_page_order_invalid` guard (`agent-check.ts:218-220`).
  - the MCP deferred commit (`:321`).
  - the follow loop (`signals.ts:2682`).
  - the arrival-watch baseline (`arrival-watch.ts:671-677`). This reads one row newest-first, and a newest-first `(ms, id)` order now gives the same maximum that the ascending cursor uses. This is an improvement.
- **Heal** (`migration:99-100`), as printed by `pg_get_viewdef`:
  `ROW(date_trunc('milliseconds'::text, later_signal.created_at), later_signal.id) > ROW(date_trunc('milliseconds'::text, s.created_at), s.id)`.
  Truncation to milliseconds does not depend on the time zone. No zone offset has a fraction of a second.

**Same-millisecond pair, measured** (`k1-matrix.out`). A is the high id at `.000100`. B is the low id at `.000900`. The pages are one row long, and each cursor is carried at millisecond precision:

```
C3 NEW order pages: page1=B, page2=A (expect B,A)                        => B,A
C3 OLD order pages (control; expect A,none = B skipped)                  => A,none
C3 B (first shown) observed -> A (next in check order) eligible (expect t) => true
C3b A observed -> B (earlier in check order) healed (expect f)           => false
C3-MUT microsecond heal: B observed -> A eligible (expect f)              => false
```

The old-order control reproduces Grok's skip. The new order shows each row once. The microsecond-heal mutation hides
A, which the seat never saw. The lead's `r5-mut-micro.log` shows the same failure (`actual: []`) in the served test.

**Other readers of the query.**
- The legacy newest-first feed, channels, `since`, and `in_reply_to` (ascending) only change the order of rows inside one millisecond. No cursor is involved, and the client re-sorts with the same comparator.
- H0 poll/ack (`h0/poll-ack.ts:408`) and the durable claim (`durable-delivery.ts:409`) have their own lease-ordered SQL. They do not read this query.
- The web app reads `swarm_read.signals` through PostgREST, not through the read edge.
- MCP uses `checkAgentMessages`.

**Index use, measured** (`plan.out`, 40,000 signals, custom-plan literals as with `prepare: false`). The old and new
plans are the same shape: `Index Scan using signals_workspace_newest` → `Subquery Scan on s` (the view is not
flattened) → `Sort` (top-N heapsort for the feed). Neither version uses the index order to stop early. Execution time
was 546 ms against 548 ms for the feed and 578 ms against 599 ms for the inbox. The change costs no index use.

**Human REST path.** It is not fixed, and it was not claimed as fixed (see F2).

## Check 2: catalog proof

`catalog-real.out` (the installed view, read-only, `\gset` replaced by `;`) gives `t`. `catalog-mutations.out` uses a
`CREATE OR REPLACE VIEW` for each case in its own rolled-back transaction:

```
control_identity (the migration's own text)  t
M1 microsecond tuple                          f
M2 enqueue-order heal                         f
M3 no later kind filter                       f
M4 no release cutoff                          f
M5 >= instead of >                            f
M6 millisecond created_at without id          f
```

The a3736201 proof text on the installed view gives `f` (`catalog-old-proof.sql`). This confirms LANE's "restoring the
old proof line fails".

For section 5 of `deploy/RELEASE-TO-BOX.md`:
- The pre-apply step requires `0:f`. The view is absent, so COALESCE gives `f`.
- The in-transaction apply step requires `t` after `\i` of the migration. The same text gives `t`.
- Verify (`:997-1001`) requires `t`.
- Line 1002 skips this version's functional proof at this step.

Section 5 can pass.

## Check 3: the cutoff test

The cutoff test is `managed-delivery.test.ts` "the release cutoff alone keeps pre-release backlog out after an old ACK".

1. It posts two asks.
2. It moves `applied_at` to after both asks.
3. It ACKs the older ask unclaimed, so the seat is known after the cutoff.
4. It requires `[]` and a false receipt bit.
5. In a rolled-back transaction, it drops only the `d.enqueued_at >= …` line (`replaceOnce` asserts exactly one match) and requires `[backlog]`.

The mutation leaves the known-seat EXISTS and the heal in place. So `[backlog]` proves that the cutoff is the only
predicate that excludes it. Without step 5, step 4 would pass for the wrong reason only if something else excluded
the backlog, and step 5 rules that out. My C4 probe gives the same result: V is not eligible with the cutoff, and
`C4-MUT no enqueued cutoff` gives `true`.

There is one theoretical flake. If the two `postAsk` calls land in the same millisecond with inverted ids, the heal
would also hide the backlog and step 5 would fail. Each ask goes through HTTP to the command edge, so this is not
practical.

## Check 4: K1, K2, I1-I4, and controls

- **K1** (`k1-matrix.out`):
  - C1: an inverted enqueue gives `true`.
  - C2a/C2b: ties in the same microsecond give `false`/`true`.
  - C5: a later observed ask for recipient 1 heals, giving `false`.
  - C3/C3b/C3-MUT: as shown above.
- **K2:** `agent-check.ts` is unchanged since my round-4 mutation table (helper, persist site, cap test).
- **I1:** the agent-token receipt gives `true/true`. A nonmember receipt gives `null`. The nonmember sees 0 roster rows and the owner sees 1.
- **I3:** the grants give `f,f,f,f` and `f,f`.
- **I2:** see check 3.
- **I4:** see F1.
- **Pure tests** that read the edge or migration source (`read-edge-diagnostics`, `delivery-receipts`, `protocol-workspace`, `chat-signal-wire-compat`, `workspace-name-agreement`, `file-create-rate-limit`, `delivery-client`) passed 207/207, exit 0, with a temporary HOME (`focused.log`).
- `deno check supabase/functions/read/index.ts`: exit 0.
- **Controls fail on revert:**
  - Catalog: measured above.
  - Heal microsecond revert: measured, and it matches the lead's log.
  - Read-edge ORDER BY revert: measured in SQL (page 2 is `none`). This matches LANE's "page 2 is empty".

## Check 5: LANE.md and the box order

The order at `LANE.md:16` is runnable: migration (section 5 passes), then the edge archive (section 6 releases every
function, including `read`), then the seeded functional proof. The Lead fold's claims agree with what I measured and
with the lead's `r5-managed.log` (23/23) and `r5-mut-micro.log`. I found no false claim. The gaps are in F3 and F4.

---

## Findings

### F1. RIGOUR: the heal join costs 0.7–1.3 s at the shape I4 measured at 36 ms, and LANE's "no index" ruling still rests on 36 ms

`LANE.md:108` (I4) says: "Added no index … Opus measured 36 ms with 50,000 observed rows, 200 known seats, and five
stale rows per seat". That measurement was for the fold-2 predicate. The fold-4 view, which fold 5 keeps, joins every
`later` row to `swarm.signals` (`migration:94-108`).

I measured the same shape on the current view (`view-cost.out`, rolled back): 200 seats, 250 asks each, 245 observed,
and 5 stale, for 50,000 deliveries. The roster aggregate took **718 ms**. The plan is a
`Nested Loop Anti Join … Rows Removed by Join Filter: 245000`. For each stale row it runs
`Bitmap Index Scan on signal_deliveries_pkey (actual rows=250 loops=1000)` with only
`recipient_agent_principal_id` as the condition. That column is the second key of the pkey, so every loop scans the
whole index (`Heap Blocks: exact=249990`).

`view-cost-compare.out` swaps only the comparison, on the same data and the same plan:

| Heal comparison | Time |
|---|---|
| millisecond | 1269 ms |
| microsecond | 1068 ms |
| enqueue | 1199 ms |

These times were noisy, because the lead's suite was running at the same time. The comparison does not drive the
cost, so **c61ae4a7 adds no measurable cost**. The signals join from fold 4 and the missing index do.

The cost grows with (stale rows) × (all deliveries in the table). A seat that checked once and then stopped collects
stale rows until `until` expires. The roster polls every 30 s for each viewer. On a read error, the roster degrades
to no mark (G8). At release there are no observed rows, so the hazard grows over time; it does not start on day one.

The Lead fold's "Not established: … query cost of the heal join" is true. But I4's "no index" ruling now rests on a
number the current view does not meet. Record these figures in LANE. Before release, get the production count of
`signal_deliveries` and of stale rows from HezLead. Plan a partial index on
`(workspace_id, recipient_agent_principal_id) WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL`.
I did not create the index here: it would take a SHARE lock on `signal_deliveries` during the lead's run.

### F2. RIGOUR: the human REST paging path keeps the microsecond order against a millisecond cursor comparator

The brief asks whether a same-millisecond pair is now shown exactly once on every paging path.
- **Every read-edge path:** yes (check, follow, arrival watch, MCP).
- **The human PostgREST path:** no. It is `src/cloud/signals.ts:1113-1123`:

```ts
url.searchParams.set("created_at", `gte.${query.after.created_at}`);
…
ascending ? "created_at.asc,id.asc" : "created_at.desc,id.desc",
```

That order is microseconds, and `rowsAfterCursor` then filters with the millisecond comparator. A page that stops
between A (`.100`, high id) and B (`.900`, low id) sets the cursor to A. The next page drops B.

This bug existed before the lane. It is human-only. It does not feed the wake-path heal, because human reads are not
delivery rows. The status line of the task doc says "the same-millisecond skip is FIXED". Scope that line to the read
edge, and name the human REST path as still open.

### F3. RIGOUR: two superseded fold rows in LANE.md still have no marker

- `LANE.md:79` (Fold 2, H2) says "observes a later-enqueued signal". Round 4 asked for a line saying that Fold 4 supersedes this. No such line was added.
- `LANE.md:127` (Fold 4, K1) says "compares `(created_at, id)` in the same order as `cswarm check`". The Lead fold (`:158`) changes check order to milliseconds, but the header at `:146-148` names only "Fold 4's 'reasoned, not measured' mutation claims and I2". It does not name K1's tuple.

The heading at `:143` says "a3736201 and the next commit", but the fixes are two commits, `d3d49fcd` and `c61ae4a7`.
Name them by hash.

### F4. RIGOUR: the box order adds the read edge but supplies no read-edge probe

`LANE.md:16` now says the box release covers "the command and read edges". `deploy/RELEASE-TO-BOX.md:1224` requires
"the lead-supplied loopback probes for every changed function". LANE supplies a command-edge flow (the observed ACK
and the seeded note), but no read-edge probe. The generic "authenticated read" control is recorded as NOT VERIFIED
when no smoke credential exists (`:1226-1228`).

The dedicated test seat already exists in section 6. Add one loopback `POST /functions/v1/read` with that seat's
credential: `inbox: true`, cursor mode, `include_stale: false`. It must return 200 and contain the seeded note. A raw
read does not ACK, so the note stays "unchecked" for the functional proof.

The risk is low, because the served suite exercises the new ORDER BY on the same PostgreSQL 17.6. Even so, an SQL
error here would break every agent inbox read.

## Not established by me

- The served server suite at `c61ae4a7`. I relied on the lead's `r5-managed.log` (23/23) and `r5-mut-micro.log`, and on my own SQL emulation of the read query.
- The read-edge ORDER BY revert through HTTP. I emulated it in SQL only.
- `npm test`, `test:p1-cli`, and the site suite at this SHA. `src/` and the pure tests are unchanged since round 4.
- Production row counts, and the heal-join cost on the box.
- The commit-order skip, which is still open and reasoned from code only.
- Any box state.

None of F1–F4 blocks the release order or makes a claim false. All four are RIGOUR. Checks 1–5 hold as measured.

VERDICT: PASS
