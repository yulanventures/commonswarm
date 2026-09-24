# Item G lane 1 landing: check acks what it showed; a stale wake path is visible (2026-09-24)

Branch `lane/item-g-lane1` from main `4d4cb3f7`, tip `36c36228`, merged with `git merge --no-ff` (merge `2c037b83`; the merged tree equals the lane tree).
Spec: `docs/design/2026-09-24-ITEM-G-LANE-1-BRIEF.md`. The lane record, fold by fold and the lead fold, is
`docs/evidence/2026-09-25-item-g-lane1/LANE.md`. Review outputs: `arms/` here.

## What it does

- `cswarm check` (profile path, `--hook`, and the MCP `check` tool) sends an unclaimed `observed` ACK for each directed
  ask or note it presented, after presentation and cursor commit. A failed ACK never changes check's output; the queue of
  pending ACKs is bounded (200 ids, retry metadata only for queued ids, backoff at most 60 s, dropped after 24 h).
- The command edge accepts that ACK only for a directed delivery to the calling principal, idempotently, with the
  session fence for managed principals. A migration widens `signal_deliveries_check9` for exactly that shape.
- One private view, `swarm.wake_path_eligible_deliveries`, decides which unobserved rows count against a seat. A seat
  is "known" once it sent an observed ACK after the release cutoff. A later observed ACK of a directed ask/note in check
  order heals earlier mail. The release cutoff keeps a behind seat's pre-release mail out.
- "Check order" is `(created_at cut to milliseconds, id)` in the read edge's `ORDER BY`, its cursor, the client
  comparator, and the heal. Before this lane the read edge ordered pages in microseconds while its cursor compared
  milliseconds, so check could skip a same-millisecond row.
- The roster (member-scoped aggregate `swarm_read.agent_wake_path`) marks a seat whose oldest eligible row is older than
  `WAKE_STALE_MS` (3 x `IDLE_POLL_MAX_MS`, 180 s); a sender's receipt says the wake path is not observing and gives
  the operator a next step. Both read the same private view. A nonmember sees nothing.
- A partial index `signal_deliveries_unclaimed_observed` serves the known-seat and heal lookups.

## Release order (required)

Migration `20260925000001` and the command and read edges reach the box first (RELEASE-TO-BOX.md; section 5 catalog
proof, section 6 edge probes including the read-edge probe in LANE.md and the functional proof with a seeded note), then
npm (cswarm) and the site. The exact steps, the probe body, and the `search_path` precondition are in LANE.md "Box
release order". Until then the client's unclaimed ACK is refused and dropped by typed refusal, and the roster
tolerates the missing view.

## Review (D-036)

Maker: Codex gpt-6-sol (direct `codex exec` lane), folds 1-4. Lead commits: fad542e0, 321c5406 (fixtures), a3736201
(fold-4 fixtures), d3d49fcd (catalog proof, cutoff test), c61ae4a7 (check order), ec44cc95 (index), a1a3fd74
(read-edge probe body, exact index proof, timings), 36c36228 (LANE wording and the search_path precondition; text only,
after the final pair). Checker: Claude
Opus 5.5. Second arm: Grok 4.7.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | bb229da9 | FAIL | FAIL |
| 2 | a503577e (Grok); fad542e0 (Opus) | FAIL | FAIL |
| 3 | 321c5406 (Opus); 5c188ac4 (Grok) | FAIL (agent-sender receipts) | FAIL (heal order and kind) |
| 4 | a3736201 | FAIL (stale catalog proof; cutoff claim; records) | FAIL (stale catalog proof; millisecond cursor skip) |
| 5 | c61ae4a7 | PASS (four RIGOUR: index cost, PostgREST path, records, read-edge probe) | PASS |
| 6 | ec44cc95 | FAIL (section-6 read-edge probe body invalid and too early; LIKE index proof; timings) | FAIL (same) |
| 7 | a1a3fd74 | PASS (two wording fixes; search_path note) | PASS |

## Gates

Merged tree `2c037b83` (equal to the lane tree), local stack reset with this migration, 2026-09-24 ~21:50Z: build 0;
test:p1-server 260/260; npm test 956/967, the 11 failures are `host-acp-*` timing tests under parallel file runs
(the four `host-acp-*` files with `--test-concurrency=1`: 84/84; the same tests fail on main `4d4cb3f7` under load);
test:p1-cli 939/939; check:tests 0; check:edge 0; `npm run build:command-core && git diff --exit-code
supabase/functions/_shared/protocol.js` 0; `scripts/build-release.sh` 0; site build 0; site test 575 pass (576, 1
skipped); `git diff --check origin/main...HEAD` 0 after this record trimmed blank lines at the end of the probe outputs.
Mutation controls, measured on the reset stack, are in LANE.md "Lead fold".

## Not established

- The box release and the proofs under the box's database role; production row counts and heal-join cost on the box
  (HezLead sends row counts).
- Live stale marks and receipts on production; the attended-seat done-test.
- The commit-order cursor skip (reasoned, open) and the human PostgREST same-millisecond skip (open); both are in
  `docs/design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md`.
- Lanes 2 and 3 of item G.
