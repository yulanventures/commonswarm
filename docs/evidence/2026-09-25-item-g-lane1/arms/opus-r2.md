# Item G lane 1 — Checker review (Claude Opus arm), round 2

Subject: `lane/item-g-lane1` at `fad542e0` (fold 1 `e433f48a` + `a503577e`, lead test commit `fad542e0`, on `bb229da9`).
Worked on a fresh `git archive fad542e0` at `scratchpad/itemG/opus-r2-probes/` (node_modules symlinked, `npm run build` exit 0).
No tracked file changed, no commit, no production host contacted, no cswarm command run. The local stack was read. Every
write was in a transaction that was rolled back (a leftover count of 0 was checked after each probe). No db:reset or db:stop.
Probe scripts: `opus-r2-probes/probes/{g1,g2-states,g2-receipt,g5-lock}.ts`. The psql runs for G6 are inline and printed below.
Logs: `scratchpad/itemG/opus-r2-focused.log`, `scratchpad/itemG/opus-r2-g9.log`.

Focused gates on the archive: `tests/delivery-client.test.ts`, `tests/delivery-receipts.test.ts`,
`tests/p1-cli/{agent-onboarding,mcp-stdio,receipt,hook-routing}.test.ts`: **172/172 pass**, exit 0.

---

## Ruling-by-ruling result

| Ruling | Result |
|---|---|
| G1 | PASS (measured) |
| G2 | PARTLY. The view and receipt logic are correct in every case (measured), and each view filter is killed by a test. But finding R2-2 is a new path to a TTL-long false stale mark. |
| G3 | PASS (measured, overrun at most 3 ms) |
| G4 | PASS for typed refusals (measured). The transient cap feeds R2-2. |
| G5 | Shape PASS (measured). The lock claim is false as applied (R2-3). |
| G6 | FAIL. When the seed variable is missing, the proof exits 0 without proving anything, and the runbook's Verify command omits the variable (R2-1). |
| G7 | PASS (code and unit test) |
| G8 | PASS (code). The site control only matches text. |
| G9 | PASS (the mutation is now killed) |

---

## Findings

### R2-1. PRODUCTION — the functional box proof passes silently when its seed is missing, and the runbook never supplies the seed
`deploy/release-proofs/item-g/20260925000001-functional.sql:5-9`:

```sql
\if :{?item_g_seed_signal_id}
\else
\echo 'item_g_seed_signal_id is required'
\quit 1
\endif
```

psql's `\quit` takes no exit code. With `ON_ERROR_STOP=1`, which `release_psql_ro` sets (`deploy/RELEASE-TO-BOX.md:589`), it
prints a warning, ends the script, and the process exits **0**. Measured on the local container's psql with the real proof file:

```
== positive control:                    exit=0 :: PROOF_COMPLETED
== missing -v (runbook literal Verify): exit=0 :: item_g_seed_signal_id is required
   psql:/tmp/opus-g6-proof.sql:8: warning: \quit: extra argument "1" ignored  PROOF_COMPLETED
```

The runbook's Verify step (section 5) runs `release_psql_ro --file "/proof/${VERSION}-functional.sql"` with no `-v`, right after
the migration and BEFORE the command-edge release (section 6). The proof's precondition, a post-cutoff unclaimed observed ack,
cannot exist until the new edge is live. So in the documented order, the Verify step always takes this branch, and the release
records a green functional proof that checked nothing. This is the false-success pattern in AGENTS.md.
Fix: make the missing-variable branch fail. Replace `\echo` + `\quit 1` with
`DO $$ BEGIN RAISE EXCEPTION 'item_g_seed_signal_id is required'; END $$;` (under ON_ERROR_STOP this exits 3). Then state in
the release plan that version 20260925000001's functional proof runs after the section 6 edge release and the seed ACK, with
`-v item_g_seed_signal_id=<uuid>`, and that the section 5 Verify run is expected to stop on this version.

Every other failure mode fails for its stated reason. Measured, each inside a psql transaction that was rolled back, with
exit code 3 under ON_ERROR_STOP:

```
unknown seat (no observed ack) -> seed signal is not an eligible live unobserved delivery for a known, active seat
revoked seat                   -> (same)
owner left                     -> (same)
pre-cutoff seed                -> (same)
expired seed                   -> (same)
seed already observed          -> (same)
competing mail                 -> seed seat has other eligible mail; use a dedicated test seat
view returns nothing           -> wake-path view omitted exact seeded unobserved delivery
view without member gate       -> wake-path view exposed a row to a nonmember
```

### R2-2. PRODUCTION — a short outage turns a checking seat into a false stale seat for up to the signal TTL
`src/cloud/agent-check.ts` (`AGENT_CHECK_ACK_MAX_ATTEMPTS = 3`. In `ackPending`, an id is dropped when
`!transient || next.attempts >= AGENT_CHECK_ACK_MAX_ATTEMPTS`), together with the view's row rule.

- Client, measured (a probe test in the archive, removed after the run): with every ack returning 503, 25 rows cost
  `75` requests in total, then **zero**. A retry counts as one attempt per check, with no backoff. So 3 checks during an
  outage drop the id for good, and hook turns can be seconds apart, so an edge restart is enough.
  `401 session_expired` and `409 session_conflict` are dropped after one request (measured: 25 requests for 25 rows, then 0).
  The read edge has no session fence (`supabase/functions/read/index.ts`), so a managed seat whose 120 s session lapsed can still read
  and present mail while each ack gets a 401.
- Server, measured (`g2-states.ts`, case 7): the dropped row stays unacked, live, post-cutoff and directed. The seat is already
  "known", so the row counts. check never presents it again, because the cursor is past it.
- Result: after the outage, the roster shows "Wake path stale" and the sender's receipt says "The recipient's session has not
  checked this in 3m", although the seat checks every turn. This lasts until `signals.until` passes: 7 days for an ask, 30 days
  for a note by default (`command/index.ts:647-651`). G2 required the mark to be "never permanent or false".
- The ruling's own tests pin this behavior: "transient observation retries stop at the attempt and age caps" asserts exactly 3.
- Fix (either one, the first is preferred): make the server rule heal itself. Do not count a row if the same seat has an observed ack
  for a signal that sorts after this row's signal (check presents in ascending order, so a later observed row means this row was
  presented). Or, on the client, keep transient failures, 401 and 429 until the 24 h age cap, with backoff, and drop at once only
  on terminal codes (409 `delivery_ack_conflict`, 403, 404, 400).
- How often this happens on production: NOT established.

### R2-3. RIGOUR — "NOT VALID then VALIDATE" still holds ACCESS EXCLUSIVE for the whole validation
`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:21-31`. The runbook applies each file in one transaction.
`DROP CONSTRAINT` and `ADD … NOT VALID` take ACCESS EXCLUSIVE, which is held until commit. So VALIDATE scans while the table
is still locked exclusively. Measured, in a transaction that was rolled back:

```
after DROP: AccessExclusiveLock
after ADD NOT VALID: AccessExclusiveLock
after VALIDATE (same tx): AccessExclusiveLock,ShareUpdateExclusiveLock   validate ms 1.5
```

The cost is small at local size (1.5 ms). But LANE.md and the test "migration admits only error-free unclaimed observed rows without a
validation lock" (`tests/delivery-client.test.ts`) claim something the database does not do, and that test only matches the SQL text.
Either put VALIDATE in a second migration file, or correct the claim to say the lock is brief because the table is small.

### R2-4. RIGOUR — the receipt's `wake_path_observing` SQL has no server test
The migration's second copy of the eligibility rule (the wrapper `swarm_read.signal_delivery_receipts`) is exercised only by
client fixtures that inject `wake_path_observing: true/false` (`tests/delivery-receipts.test.ts:468,477`,
`tests/p1-cli/receipt.test.ts:185,547`). No server test calls the function, and the catalog proof does not check it. So any of
its filters could be removed and every gate would stay green. It is correct today. Measured (`g2-receipt.ts`): unknown seat `false`, known seat
with a live row `true`, pre-cutoff `false`, expired `false`, after ack `false`. It also duplicates the view's predicate by hand, so the two can drift.
Also, the renamed inner function `signal_delivery_receipts_without_wake_path` keeps EXECUTE for `authenticated` and `swarm_read`.
The earlier rename pattern (`…_without_main_queue_count`) revoked those grants. Measured from `pg_proc.proacl`.

### R2-5. RIGOUR — the revoked-principal filter has no failing test
The mutation that removes `(p.revoked_at IS NULL)` from the view makes a revoked seat visible (measured: case 8 changes from 0 to 1), but
no server test covers revocation. The other three filters are killed (below).

### R2-6. RIGOUR — several fold tests only match source text
The G5 lock test, the G8 site control (`dashboard.includes('if (wakeError) return result;')`), the G6 proof test and the
view-filter test in `tests/delivery-client.test.ts` use regexes over files. Claim controls prove stability, not truth (AGENTS.md).
R2-1 and R2-3 are two cases where the text passed and the behavior did not.

---

## Measurements behind the PASS rows

**G1** (`probes/g1.ts`, the lane's `ackAgentDelivery` on the real schema, rolled back):
```
enqueued row binding: {"session_id":null}
managed, enqueued row, proof A: accepted      replay: idempotent
row bound to session B, proof A: session_conflict  acked: false
row bound to session B gen 3, proof B gen 2: session_conflict
row bound to session B gen 3, proof B gen 3: accepted
managed, proof null: session_conflict
```
The unit test now uses the enqueued shape (`session_id: null`) and has a row-bound-elsewhere negative that reaches the branch.
The server test's generation+1 negative still reaches only the generic fence, and its label now says so.

**G2** (`probes/g2-states.ts`, the real view, then each filter replaced with `true` through `CREATE OR REPLACE VIEW` inside
a transaction that was rolled back; the expired row gets a real delivery row because it is posted live and then expired, as in the server test):

| case | real | no until | no cutoff | no observed-seat EXISTS | no revoked |
|---|---|---|---|---|---|
| unknown seat, live row 4 min old | 0 | 0 | 0 | **1** | 0 |
| known seat, pre-cutoff row | 0 | 0 | **1** | 0 | 0 |
| known seat, expired row, enqueued now | 0 | **1** | 0 | 0 | 0 |
| known seat, expired row, enqueued 4 min ago | 0 | **1** | 0 | 0 | 0 |
| leased row | 0 | 0 | 0 | 0 | 0 |
| known seat, live post-cutoff row 4 min old | 1 | 1 | 1 | 1 | 1 |
| same, other member / nonmember | 1 / 0 | | | | |
| revoked principal | 0 | 0 | 0 | 0 | **1** |
| owner left: owner / other member | 0 / 1 | | | | |
| after the observed ack | 0 | 0 | 0 | 0 | 0 |

The lead's suspicion is not correct. The view has NO age filter, because age is applied only in the client (`wakePathMark`). So an expired row that
was enqueued "now" still appears when the until filter is removed. The server test reads `wakePathRows(...).length === 0`
with no age condition, so its expired assertion fails under that mutation. Its pre-cutoff assertion ("old pre-cutoff mail
cannot make a known seat stale") fails without the cutoff. Its "a seat that has never observed mail is unknown" assertion
fails without the observed-seat EXISTS. The revoked filter is not covered (R2-5).
"Owner left": deleting the membership does not revoke the seat, so the seat still counts for the other members and the owner
no longer sees it. That is true to state.

**Cutoff**: `swarm.wake_path_release` is a singleton table (`CHECK (singleton)`, PK), filled once by the migration with
`statement_timestamp()`. No date is typed. It is owned by `swarm_admin` with `relacl` NULL (no grants), and read only by the
`swarm_admin`-owned view and function. Local value: `2026-09-24T17:47:44.649Z`. On the box, it is set inside the release
transaction. A re-apply fails on `CREATE TABLE`, so the value cannot move.

**G3** (probe test, deadline `start + 1500`, 3 acks each taking 700, 1400 or 5000 ms and returning 503):
```
ackMs=700:  returned 3 ms after deadlineAtMs; acks attempted 3
ackMs=1400: returned 1 ms after deadlineAtMs; acks attempted 2
ackMs=5000: returned 2 ms after deadlineAtMs; acks attempted 1
```
Round 1 measured 634 ms. The 150 ms hook margin now covers it. The output is written by `present` before any ack.

**G4** (25 rows, drain, then 5 empty checks):
```
409 delivery_ack_conflict: total 25     403 delivery_unavailable: total 25
409 session_conflict:      total 25     401 session_expired:      total 25
503 temporarily_unavailable: total 75 (3 per row, then dropped — see R2-2)
```

**G5 shape** (real table, rolled back): `observed/null` ACCEPTED, `observed/some_code` REJECTED check9, `replied` REJECTED,
`queued` REJECTED, `failed_terminal/other` REJECTED, `failed_terminal/delivery_attempts_exhausted` ACCEPTED, `expired`
ACCEPTED. `convalidated = true`. The catalog proof now checks the definition, `convalidated`, and that no other CHECK requires
the lease pair without an `observed` escape.

**G7**: the idempotent `observed` return is back before the queued path's session check. The unit test "queued observation replay
stays idempotent across a new session" covers it.

**G8**: `LiveDashboard.astro:2029` `if (wakeError) return result;`. `NO_LISTENER_STATUS_SENTENCE` = "No listener is running for
this agent in {stateDirectory}. …", filled with `paths.instanceDirectory` (`src/cli.ts:7352`).

**G9**: the same mutation as round 1 (`visibleIds = presented`), rebuilt: `tests/p1-cli/mcp-stdio.test.ts` fails 1/22
("only the response's visible prefix may be observed"). After the restore and rebuild, the file matches HEAD and 172/172 pass.

## Not established
- Production frequency of R2-2: edge restarts during active hook turns, and lapsed managed sessions on attended seats.
- `test:p1-server` was not rerun by me. The lead reports that file 10/10 at `fad542e0`. My G1 and G2 results are in-process on the real local schema.
- The name of the check9 constraint on the box. The catalog proof now fails closed if another CHECK still requires the lease pair.

VERDICT: FAIL
