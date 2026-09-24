# Item G lane 1 — Checker review (Claude Opus arm), round 3

Subject: `lane/item-g-lane1` at `321c5406` (Codex fold 2 `5c188ac4` plus the lead's fixture commit `321c5406`).
Worked on a fresh `git archive 321c5406` at `scratchpad/itemG/opus-r3-probes/` (node_modules symlinked, `npm run build` exit 0).
No tracked file changed, no commit, no production host, no cswarm command except `dist/cli.js --version --url http://127.0.0.1:54321`.
Every database write was in a transaction that was rolled back. The leftover-row count was 0 after each probe, and the cutoff row is
unchanged (`2026-09-24T18:40:16.844Z`). No db:reset or db:stop. I left no temp files in the container.
Probes: `opus-r3-probes/probes/{r3-replay,r3-agent-receipt,r3-plan}.ts`. The psql matrix is inline below.
Focused gates: `tests/delivery-client.test.ts`, `tests/delivery-receipts.test.ts`,
`tests/p1-cli/{agent-onboarding,mcp-stdio,receipt,hook-routing}.test.ts`: **172/172**, exit 0 (`scratchpad/itemG/opus-r3-focused.log`).

| Ruling | Result |
|---|---|
| H1 | PASS: every failure mode exits 3, and the release order can be followed |
| H2 server | PASS for its stated purpose (see below for what it can and cannot hide) |
| H2 client | PASS (measured) |
| H3 | Test is independent of the cutoff age: PASS. But its cutoff assertion passes for the wrong reason (R3-2). |
| H4 | PASS: the claim is corrected and the lock is measured on the DB |
| H5 | One source: PASS. But the shared view broke receipts for agent senders (R3-1). |
| H6 | PASS (measured ACLs) |
| H7 | PASS: no test left that only matches text for a DB claim |
| Lead fixture | Does not weaken the test (it was broken without it). Two filters are not killed, for reasons that predate it (R3-2). |

---

## Findings

### R3-1. PRODUCTION — agent senders never get the stale receipt (a regression from H5)
`supabase/migrations/20260925000001_unclaimed_observed_ack.sql`, the view `swarm_read.agent_wake_path_deliveries`, ends with
`AND swarm.is_member(d.workspace_id, auth.uid())`. The receipt wrapper now reads `wake_path_observing` from that view.
The read edge calls the receipt function for an agent-token caller with NO `request.jwt.claims`
(`supabase/functions/read/index.ts:544-552`: "That absence selects the function's agent-token branch"). So
`auth.uid()` is NULL, `is_member` is false, and `wake_path_observing` is always `false` for every receipt that an agent reads.
Measured (`probes/r3-agent-receipt.ts`, rolled back). The seat is known. The row is post-cutoff, live, unobserved and 4 minutes old:

```
agent sender, agent-token path: { addressed: true, bits: [ false ] }
human sender, JWT path:         { addressed: true, bits: [ true ] }
agent-sent row is unobserved, post-cutoff, live, seat known: true
```

The text is not false: it falls back to "Not yet delivered…". But decision 4's stale receipt never appears for an agent sender,
and agents are the main senders of directed asks. Fold 1's function had no member gate, so this worked in round 2.
The server tests call the function only with an owner JWT (`receiptWakePath`, `tests/p1-server/managed-delivery.test.ts:257-265`),
so no gate sees this. The brief's production control fails if the directed note is posted by an agent.
Fix: keep one source, but split it in two:
1. `swarm.wake_path_eligible_deliveries`: no member gate, no grants, owned by swarm_admin. The SECURITY DEFINER receipt wrapper reads this one. The inner function has already authorized the caller.
2. `swarm_read.agent_wake_path_deliveries`: the same source plus `is_member(...)`, for the roster.

Add a server test that calls the function on the agent-token branch (no claims, with `p_agent_token_hash`) for a stale row.

### R3-2. RIGOUR — two view filters survive mutation. The "seconds-old cutoff" assertion passes for a different reason
I replayed the three wake server tests in order, with the lead's fixture (`probes/r3-replay.ts`: the same steps and
assertions, in-process with `ackAgentDelivery`, in a rolled-back transaction, with each filter of `agent_wake_path_deliveries`
replaced by `true`):

```
real:                           all assertions pass
no cutoff (d.enqueued_at):      all assertions pass            <- survives
no until:                       FAILS expired / receipt expired / eligible==[live] / ACK clears
no observed-seat EXISTS:        FAILS "no observed ACK means unknown"
no observed.acked_at>=cutoff:   all assertions pass            <- survives
no later-observed rule:         FAILS the later-observed test (4 assertions)
no revoked:                     FAILS the revoked test (2 assertions)
```

The reasons:
- "a seconds-old cutoff excludes the four-minute-old row" passes without the `d.enqueued_at` filter. Moving the cutoff to
  `statement_timestamp()` also places the seat's only observed ack (`first`) BEFORE the cutoff. The observed-seat EXISTS
  (`observed.acked_at >= cutoff`) is then false, the seat becomes "unknown", and the row disappears for that reason.
- "old pre-cutoff mail cannot make a known seat stale" is also vacuous. The pre-cutoff row is older than `first`, so the later-observed
  rule hides it whether or not the cutoff filter exists.
- The lead's fixture did not cause this. Before it, the test failed on the product (the `live` row was hidden), and the cutoff assertion was
  already masked by the later-observed rule. The fixture is correct.

Impact: low. With the later-observed rule, the `d.enqueued_at` cutoff is nearly redundant for a known seat. But the test claims a behavior it does not
reach ("a negative result must reach the path it claims to test"). Fix: keep `first` acked AFTER the moved cutoff
(for example, ack a fresh row after the `applied_at = statement_timestamp()` update, enqueued earlier than `live`), or make a case where only the
enqueued cutoff separates the row.

### R3-3. RIGOUR — the functional proof keeps its own copy of the eligibility rule
`deploy/release-proofs/item-g/20260925000001-functional.sql` repeats the eligibility predicate by hand, and that copy has no later-observed rule.
When a later observed row hides the seed, the proof reports "wake-path view omitted exact seeded unobserved delivery", which is the wrong reason (measured
below). In the documented flow the seed is the newest note, so this happens only if the seat checks it. The proof could select the seed
from `swarm.agent_wake_path_deliveries` or its non-member twin (R3-1) instead.

### R3-4. RIGOUR (performance, not a blocker) — the view hashes every observed row of the workspace
`probes/r3-plan.ts`: 50,000 observed rows and 200 known seats with 5 stale rows each, as the owner: **36 ms**, with
`Seq Scan on signal_deliveries later` (50,000 rows) feeding a Hash Anti Join and `Index Scan … signal_deliveries_terminal_acked`
(50,000 rows) for the observed-seat EXISTS. The cost grows linearly with 30-day acked retention, once per open dashboard every 30 s.
An index on `(workspace_id, recipient_agent_principal_id, enqueued_at) WHERE ack_outcome = 'observed' AND last_lease_id IS NULL`
would bound it. The production row count is NOT established.

---

## Measurements behind the PASS rows

**H1** (real proof file, local psql with `ON_ERROR_STOP=1`, each case in a rolled-back transaction):
```
positive control:                   exit=0  PROOF_COMPLETED
missing seed:                       exit=3  item_g_seed_signal_id is required
unknown seat:                       exit=3  seed signal is not an eligible live unobserved delivery for a known, active seat
revoked seat / owner left / pre-cutoff seed / expired seed / seed already observed: exit=3 (same message)
competing mail:                     exit=3  seed seat has other eligible mail; use a dedicated test seat
seed hidden by a later observed row: exit=3  wake-path view omitted exact seeded unobserved delivery   (R3-3)
view returns nothing:               exit=3  wake-path view omitted exact seeded unobserved delivery
```
Release order: section 5 skips this version's functional proof (`RELEASE-TO-BOX.md` Verify block). Section 6 posts note 1 through the
box loopback command endpoint, acks it unclaimed with the seat credential, posts note 2 and leaves it unchecked, then runs
`release_psql_ro -v item_g_seed_signal_id=…`. `release_psql_ro` passes `"$@"` to psql, so `-v` reaches it. The order can be followed.

**H2 server — what the later-observed rule can hide:**
- The rule is `later.enqueued_at > d.enqueued_at AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL`.
- Leased or queued observations carry `last_lease_id`, so a listener's ack never hides a row. Only check's unclaimed ack does.
- A later signal acked "by another session" is still the same principal. Every profile's check reads that principal's inbox from its own
  cursor in ascending order, so a later ack means that reader passed the earlier row.
- Equal `enqueued_at` never hides a row (`>` is strict).
- Channels do not matter: check's inbox read has no channel filter (`read/index.ts:904-907` applies `channel_id` only when it is given).
- Rows that check skips: expired rows are already excluded by `s.until`. A row whose signal commits after a later row was read has
  `created_at` behind the cursor, so check never presents it. The rule then hides it. That is the existing cursor race, and hiding it is
  consistent with "the wake path works".
- Within one millisecond, check orders by `id` but the rule orders by microsecond `enqueued_at`. A row can be hidden one check
  before it is presented. This is harmless.
- Measured: the later-observed mutation fails 4 assertions (R3-2 table).

**H2 client** (probe tests in the archive, removed after the run):
```
G3 in-flight ack at deadline (700/1400/5000 ms): returned 4/3/3 ms after deadlineAtMs; saved attempts [1,1,1]/[1,1]/[1]
409 delivery_ack_conflict | 409 session_conflict | 403: 25 requests for 25 rows, 0 in 5 later checks, queue 0
401 | 429 | 503: 20 during drain, 5 in 5 later checks (backoff), queue 25 kept
outage then recovery (5 rows): 10 acks during outage; after recovery all 5 acked in 2 checks / 553 ms; queue 0
```
The attempt is persisted before the send (`persist({ id, retry })` precedes the request). Backoff is 250 ms × 2^n, capped at 60 s. The age cap
is 24 h. The queue is capped at 200 (`AGENT_CHECK_CACHE_LIMIT`), and each check sends at most 20.

**H3**: the test sets the cutoff to `now - 1 hour` and restores the saved value in `finally`, so it does not depend on the cutoff's age after a reset.
The assertion that claims to prove the cutoff does not reach it (R3-2).

**H4**: the migration comment (lines 15-16) now says `DROP/ADD holds ACCESS EXCLUSIVE through VALIDATE and commit`. The server test
"same-transaction validation retains the exclusive lock described by the migration" asserts `AccessExclusiveLock` in `pg_locks`
on a 100,000-row temp table, so this is a real DB check, with the comment check alongside it. LANE.md records 9.6 ms locally, labelled "not a box window
estimate". I found no remaining false lock claim.

**H5**: the roster (`agent_wake_path` = `min(enqueued_at)` over `agent_wake_path_deliveries`) and the receipt bit read the same view. Measured on
the JWT path: the view and the receipt agree in every replay case. The agent path breaks (R3-1).

**H6** (`pg_proc.proacl`): `signal_delivery_receipts_without_wake_path` = `{swarm_admin=X/swarm_admin}`, the same as
`…_without_main_queue_count`. The public function: `swarm_admin`, `authenticated`, `swarm_read`. `agent_wake_path_deliveries`
and `wake_path_release`: `relacl` NULL (owner only). `agent_wake_path`: `authenticated=r`.

**H7**: `tests/delivery-client.test.ts` no longer reads migration or proof text. The only file reads are in
`tests/p1-server/managed-delivery.test.ts`, and each is paired with a DB check: the lock comment with `pg_locks`, and the proof
file with psql exit codes.

**Other**: `scripts/build-release.sh` now calls `cswarm --version --url http://127.0.0.1:54321`. Measured: prints
`cswarm 0.1.76 (protocol 0.1.0)`, exit 0. No network is used.

## Not established
- I did not rerun `test:p1-server` (the lead reports `managed-delivery.test.ts` 17/17 at `321c5406`). My R3-1 and R3-2 results come from
  in-process replays on the real local schema, not from the served edge.
- Production row counts for R3-4. The box lock window.

VERDICT: FAIL
