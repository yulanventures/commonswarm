Fold 1 on item G lane 1 in the CommonSwarm repo, branch lane/item-g-lane1 at bb229da9. Spec:
docs/design/2026-09-24-ITEM-G-LANE-1-BRIEF.md (decisions 1-4). Both review arms FAILED; their reviews are pasted at the
end (Opus measured on the local stack). The lead's gates found tests/p1-server/managed-delivery.test.ts "managed
unclaimed observation requires the row's current session proof" failing reproducibly with 409 session_conflict. Implement
EVERY ruling, each with a test that fails when the fix is reverted; record rulings, tests and mutation results in
docs/evidence/2026-09-25-item-g-lane1/LANE.md under "Fold 1". The brief gets a dated "Correction (fold 1)" note for G2,
keeping the retired words. Read AGENTS.md and deploy/RELEASE-TO-BOX.md first.

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); never run a cswarm command without a loopback --url; NEVER run a remote supabase command;
do not run db:reset or db:stop (the lead runs the local stack); do not touch ~/.cswarm or ~/.config/cswarm; no other model;
no skill; no auto-approve flags; print no secret; every test has a timeout; no process survives. You may edit the lane's
migration (20260925000001; applied only to the lead's local stack). Commit yourself: "fix(wake): ..." / "test(wake): ...",
trailers exactly (one per line): Agent-Name: Yulan Bot / Agent-Model: <your model id> / Agent-Family: openai / Agent-Tool:
codex <version> / Agent-Model-Source: runtime-ambiguous.

RULINGS
G1 (both arms, PRODUCTION). The unclaimed branch in supabase/functions/command/durable-delivery.ts compares the proof with
   row.session_id, which is NULL on every row an attended seat never claimed, so every managed unclaimed ack fails. The
   proof itself is already validated for every command by enforceAgentSessionProof (command/index.ts). Refuse only a row
   bound to a DIFFERENT session: `managed && (proof == null || (row.session_id !== null && (row.session_id !==
   proof.session_id || Number(row.session_generation) !== proof.generation)))`. Replace the unit fixture that pre-loads a
   session on an unclaimed row with the real enqueued shape (session_id NULL); the server test must pass on the local
   stack with the real flow; the stale-proof negatives must reach the branch they name (not only the general fence).
G2 (both arms, PRODUCTION, lead ruling on the design). The stale mark must never be permanent or false:
   - A seat has THREE states: unknown (its client has never sent an unclaimed observed ack since the release cutoff),
     ok, stale. Only a seat that has sent at least one observed ack can be stale. Old clients and seats that never
     checked since the release stay "unknown" (shown as nothing, or a neutral note — not red).
   - Only rows that count: directed ask/note to that seat, unleased, unacked, NOT expired (signals.until >
     statement_timestamp()), enqueued at or after the release cutoff (recorded by the migration, e.g. a one-row table or
     a constant the view reads — not a typed date), and older than WAKE_STALE_MS.
   - The sender receipt says "has not checked this in <label>" only when the recipient seat is known-observing and the
     row counts; otherwise it keeps today's text.
   - Tests on the local stack: a pre-cutoff unacked row never makes a seat stale; an expired row never does; a seat with
     no observed ack is unknown; after one observed ack, a new unobserved row older than the threshold is stale and
     clears on the ack. Update the functional box proof accordingly (G6).
G3 (Opus, PRODUCTION). `--hook` output never changes because of acks: send acks only after the hook's output is written,
   with each request's timeout bounded by the remaining budget (never a fresh full timeout), and skip acks when the
   remaining budget is below a named floor. Measure: an ack in flight at the deadline cannot trigger the forced-exit
   failure text. Same bound for the profile path.
G4 (Opus, PRODUCTION). The retry queue retries only transient failures (network, timeout, 5xx), bounded by attempts and
   age; a typed refusal (409 conflict, session_conflict, 403, 404, invalid) removes the row from the queue at once. Test:
   N refused acks cause N requests total over 5 checks, not N per check.
G5 (Opus, Grok, RIGOUR). The widened CHECK admits exactly the one new shape: an unclaimed row with ack_outcome
   'observed' AND last_error_code IS NULL. Add the constraint as NOT VALID then VALIDATE CONSTRAINT (no long exclusive lock
   on signal_deliveries); the catalog proof checks the constraint by its definition, not only its name.
G6 (Opus, Grok, RIGOUR). The functional box proof is pinned to its seeded row (not "the oldest in the table"), skips
   revoked principals and owners who left, and can fail only for its stated reason; show each failure mode.
G7 (Opus). The queued (leased) path's idempotent replay must not newly require a matching session (restore the old
   behaviour there); only the unclaimed branch changes.
G8 (Opus). The app roster does not fail if the wake-path read fails or the view is missing: it shows the roster without
   the mark. `listen status` says "No listener is running for this agent in <state directory>" (true scope), from a
   constant.
G9 (Opus). A test that fails if the MCP check acks rows it did not include in the response (the mutation Opus ran passed
   42/42 before).

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; npm run check:edge ; npm run build:command-core && git diff --exit-code
supabase/functions/_shared/protocol.js ; bash scripts/build-release.sh ; npm --prefix site run build ;
env -u FORCE_COLOR npm --prefix site test ; git diff --check origin/main...HEAD. The lead runs db:reset and the server
suite after your fold. Name sandbox failures. Regenerate the dispatch baseline twice if it changes and list the rows.

REPORT: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.

===== OPUS REVIEW (round 1) =====
# Item G lane 1 — Checker review (Claude Opus arm), round 1

Subject: `lane/item-g-lane1` at `bb229da9` (base `origin/main` `4d4cb3f7`).
Worked on a `git archive bb229da9` copy at `scratchpad/itemG/opus-probes/` (node_modules symlinked, `npm run build` exit 0).
No tracked file changed. No commit. No production host contacted. No cswarm command run. The local stack (127.0.0.1:54322)
was read, and every write was inside a transaction that was rolled back (verified by reading the row after each rollback).
The local edge container and `db:reset` were not touched, because another arm's run was live on the same stack.

Probe scripts: `scratchpad/itemG/opus-probes/probes/` (`edge-root-cause.ts`, `table-probe.ts`, `view-probe.ts`,
`proof-revoked.ts`, `q.mjs`). Logs: `scratchpad/itemG/opus-focused.log`, `scratchpad/itemG/opus-m3.log`.

---

## The lead's measured failure: root cause

**Verdict on the question: the EDGE is wrong, the test builds the proof correctly.**

`supabase/functions/command/durable-delivery.ts:731-735` (unclaimed branch):

```ts
if (managed && (
  args.proof == null ||
  row.session_id !== args.proof.session_id ||
  Number(row.session_generation) !== args.proof.generation
)) return { status: "session_conflict" };
```

A delivery row gets a session binding at one place only: the claim, `durable-delivery.ts:359-361`
(`session_id = ${sessionId}::uuid, session_generation = ${sessionGeneration}` inside the `claim_agent_inbox` UPDATE).
An attended seat never claims. So on every row this branch is for, `row.session_id` is NULL.
`null !== proof.session_id` is always true. So a managed principal is refused **on every unclaimed ack, with any proof**.

Measured on the local stack, using the rows the lead's 3 failing runs left behind (`synth-unclaimed-managed-5e72adf7`, `-5ea66b52`,
`-c02ec537`). All three: `managed=true`, live session generation 2 in `agent_execution_sessions`, and delivery row
`session_id=null, session_generation=null, acked_at=null`. Calling the lane's `ackAgentDelivery` in-process on one of those
rows, inside a transaction that was rolled back, with the principal's CURRENT session id and generation:

```
row binding before: {"session_id":null,"session_generation":null,"acked_at":null}
lane edge, current proof: {"status":"session_conflict"}
fixed edge, current proof: {"status":"accepted",...,"outcome":"observed"}
row after fixed ack (in tx): {"ack_outcome":"observed","acked":true,"delivered":true,"surfaced":true,"last_lease_id":null}
rolled back → row after rollback: {"acked_at":null}
```

The generic session fence has already proved the proof before this branch runs: `index.ts:8939`
`enforceAgentSessionProof` (`_shared/agent-auth.ts:214-280`) is applied to every agent command except
`acquire_agent_session` (`src/cloud/session-wire.ts:140-142`). It checks session id, generation, liveness and the key hash
against `agent_execution_sessions`. The branch should only refuse a row that is bound to a DIFFERENT session.

**Fix** (the version measured as `accepted` above):

```ts
if (managed && (
  args.proof == null ||
  (row.session_id !== null && (
    row.session_id !== args.proof.session_id ||
    Number(row.session_generation) !== args.proof.generation))
)) return { status: "session_conflict" };
```

Then replace the unit test positive control (see finding 6b). Without this fix, every managed attended seat triggers findings 2, 4 and 5
on every message: nothing is ever acked, the roster and receipts show stale permanently, and every check makes up to 20 failing
round trips.

---

## Findings

### 1. PRODUCTION — managed unclaimed observation can never succeed
`supabase/functions/command/durable-delivery.ts:731-735`. The section above has the evidence and the fix. The lead reproduced it
2/2 times in `tests/p1-server/managed-delivery.test.ts` ("managed unclaimed observation requires the row's current session proof").
Item I made managed profiles the path that `check` uses (`agent-check.ts` `profileSessionContext`), so this is the main
production case, not an edge case.

### 2. PRODUCTION — stale marks and stale receipts that never clear (pre-release backlog, and expired mail)
`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:52-69` (view), `src/cloud/agent-check.ts:236-237` (only
`presented` ids are queued), `src/cloud/receipts.ts:173-179`.

(a) **Backlog.** Before this lane, `check` sent no ACK (brief, "What is true today"). So every directed ask or note ever sent to an attended
seat is still `acked_at IS NULL`, with no lease and no last lease. `purge_terminal_signal_deliveries`
(`20260731000001_signal_deliveries.sql:238-266`) deletes only rows with `acked_at IS NOT NULL`, so these rows are never purged.
The view has no cutoff, so all of them count. But the seat's local check cursor is already past them, and check queues an ack only
for rows that it presents in this run (`agent-check.ts:236-237`, `278-279`). No code path will ever ack them. So on release day,
every attended seat that has old directed mail gets a permanent "Wake path stale" mark. Every sender who looks at such an old
receipt reads "The recipient's session has not checked this in 3m", which is false because the session did check it before the release. The
brief's production control ("run cswarm check …: both clear") will not clear the badge on any seat that has a backlog. The
functional proof depends on this backlog: it picks the OLDEST unobserved group, not HezLead's seeded note
(`20260925000001-functional.sql:14-28`).
(b) **Expired mail.** check's inbox read never passes `include_stale`, so the read edge filters to
`s.until > statement_timestamp()` (`supabase/functions/read/index.ts:897`). A directed signal that expires before the seat
checks is never presented and so is never acked. Only `claim_agent_inbox` terminalizes expired rows
(`durable-delivery.ts:237-264`), and attended seats never claim. The view does not filter `s.until`, so the mark stays forever.
Fix options: a view cutoff (a `swarm.config` release timestamp, or `enqueued_at > <applied_at>`) plus `s.until > now()`
in the view; or a one-time server-side "observed through cursor" ack. Magnitude on production: NOT established (no prod access).
The mechanism is certain for any attended seat that has pre-release directed mail.

### 3. PRODUCTION (release blocker) — the functional box proof fails when the oldest unobserved seat is retired
`deploy/release-proofs/item-g/20260925000001-functional.sql:14-28`. The seed query has no `p.revoked_at IS NULL` filter and no
membership check of `p.owner_user_id`. The view has both (`p.revoked_at IS NULL`, `swarm.is_member`). If the oldest unobserved group
belongs to a retired seat, or to an owner who left the workspace, the proof raises
`wake-path view omitted seeded unobserved directed delivery`. The view is correct in that case, so the proof fails for the wrong reason. Measured
(`probes/proof-revoked.ts`, rolled back):

```
control (unchanged catalog): PASS
after retiring the oldest seat: RAISE wake-path view omitted seeded unobserved directed delivery
after rollback revoked_at: null
```

On the local stack, 3 of the 23 principals with unobserved directed mail are revoked. Production has retired seats (App Remove), and
their mail is never acked. Fix: add `AND p.revoked_at IS NULL AND swarm.is_member(d.workspace_id, p.owner_user_id)` to the seed query,
or pin the proof to the seeded signal id that HezLead records. Also add a non-member identity negative (today only the anonymous negative exists).

### 4. PRODUCTION — the ack phase can overrun the hook's absolute deadline and change hook output
`src/cloud/agent-check.ts:242-243, 252`. The per-request budget is computed ONCE, when the client is created
(`deadlineMs: Math.max(1, Math.min(AGENT_CHECK_TIMEOUT_MS, deadlineMs - Date.now()))`). The loop only stops STARTING requests at
`deadlineMs`. So a request that starts just before the deadline can run for the whole budget that was left at creation. The
`withAgentDeadline` timer is already cleared (`agent-check.ts:112`, `finally { clearTimeout(timer!) }`), so nothing else
bounds it. Measured (probe test in the archive copy, file removed after the run): 3 directed messages, acks that take 700 ms and
return 503, `deadlineAtMs = start + 1500`:

```
PROBE deadline overrun: returned 634 ms after deadlineAtMs; acks attempted 3
```

In `--hook`, `deadlineAtMs` is the process deadline minus 150 ms (`agent-check-budget.ts:38,46-52`), inside a 5 s host hook
(`HOST_HOOK_TIMEOUT_SECONDS = 5`). A 634 ms overrun reaches the `hardExit` timer (`src/onboarding-cli.ts:108-110`). That timer prints
the `check_timeout` failure text and records a diagnostic, and the next turn then prints "CommonSwarm message checks are working again."
This breaks decision 2 ("An ack failure never fails check and never changes its output"). Fix: create the client per request with
`deadlineMs - Date.now()`, or pass an `AbortSignal.timeout(deadlineMs - Date.now())`.

### 5. PRODUCTION (turn latency) / RIGOUR — permanent refusals are retried forever, 20 round trips per check
`src/cloud/agent-check.ts:258` (`catch { /* Observation is best effort… */ }`) and `:262-266`. No refusal is ever classified.
409 `delivery_ack_conflict` (a row that a listener claimed, queued, observed or expired), 403 `delivery_unavailable` and
409 `session_conflict` (finding 1) stay in `pending_observed_ids` until 200 newer ids push them out. Measured, with every ack refused 409:

```
PROBE permanent 409: acks while draining 40; acks over 5 later EMPTY checks 100
```

So after 20 permanent refusals, every `check` makes 20 extra serial requests, on every host turn, inside a 5 s hook. The
rotation test (`tests/p1-cli/agent-onboarding.test.ts` "bounded observation retries rotate past persistent refusals") asserts
this behavior. Fix: drop an id when the refusal code is terminal (`delivery_ack_conflict`, `delivery_unavailable`); retry only
transport errors, 5xx, and codes named as transient. Classify on the typed code (D-053), not on the message.

### 6. RIGOUR — the tests do not reach what they claim
(a) `tests/p1-server/managed-delivery.test.ts:594-598` and `:483-490` (`staleReplay`): a generation+1 proof is refused by the
GENERIC fence at `index.ts:8939-8955`, before `ackAgentDelivery` runs. So neither negative reaches the row-binding check it names.
Measured: `enforceAgentSessionProof` with generation+1 refused before any delivery code ran (the leftover session had since expired,
so the code shown was `session_expired`; within TTL it is `session_conflict`). A useful negative needs a row bound to ANOTHER session.
One way: claim under session A, let the lease expire, then observe under session B.
(b) `tests/delivery-client.test.ts:981-1009` ("managed unclaimed observation reaches the row session fence"). Its positive control
uses a fake row with `session_id: "session-a"`. A never-claimed row cannot have that shape, so the test encodes finding 1 as correct
behavior. Replace it with `session_id: null`, and expect `accepted` for any proof that passed the fence.
(c) Mutation that survives. I changed `agent-check.ts:278` so that `visibleIds = presented` (the MCP path acks every presented
row, including rows that `capFreshCheck` removed from the response), rebuilt, and ran `tests/p1-cli/mcp-stdio.test.ts` and
`tests/p1-cli/agent-onboarding.test.ts`: **42/42 pass**. So nothing proves "MCP acks only what the response showed".
(d) `tests/p1-cli/mcp-stdio.test.ts:712` asserts only that stdout eventually contains the id, not the order of write and observation.
The order is safe by construction, because `ackPending` reads the queue that the post-write commit persists (`agent-check.ts:245-247`).
But the test does not measure that, and the comment claims it does.
(e) The `directed` EXISTS in the edge (`durable-delivery.ts:736-750`) is unreachable. Delivery rows exist only for directed ask/note
(the trigger and the recipients roster), and the foreign-principal test returns earlier at `:703` (`if (!row)`). Keeping it as
defense in depth is fine, but no test exercises it.

### 7. RIGOUR — migration shape, lock and catalog proof
`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:22-29`.
- I enumerated old against new check9 over outcome × last-lease pair × error code (33 rows that are legal under check3/check8):
  **0 rows narrowed**, and the widened rows are only `observed` with no lease pair. On the real table (rolled back):
  `observed null ACCEPTED`, `replied null REJECTED check9`, `queued null REJECTED check9`,
  `failed_terminal other_code REJECTED check9`, `failed_terminal delivery_attempts_exhausted ACCEPTED`, `expired ACCEPTED`.
  But `observed` with `last_error_code='some_code'` is also ACCEPTED, so the rule admits the new shape with ANY error code.
  Tighten it: `OR (ack_outcome = 'observed' AND last_error_code IS NULL)`.
- Lock: `ADD CONSTRAINT … CHECK` is validated in place. It holds `AccessExclusiveLock` on `signal_deliveries` for the full scan
  (measured: 7.8 ms at 625 rows locally; production row count NOT established). There is no rewrite. With the runbook's `lock_timeout = '5s'`,
  the lock request can queue all readers and writers of the table for up to 5 s. The new rule is strictly weaker than the old one, so
  `ADD … NOT VALID; VALIDATE CONSTRAINT …` would avoid the long exclusive hold.
- The catalog proof (`20260925000001-catalog.sql:3-12`) checks the constraint only by NAME. If the box's constraint name ever
  differs, `DROP CONSTRAINT IF EXISTS` does nothing, the old rule keeps rejecting, and the catalog proof still returns `t`.
  Also assert that no other CHECK on the table requires the lease pair without an `observed` escape. The name on the box: NOT established.

### 8. RIGOUR — queued-promotion behavior change outside the brief
`durable-delivery.ts:789-797`. The managed row-binding check now runs BEFORE the idempotent `observed` return. So an idempotent
replay from a session whose (id, generation) differs from the row's binding now gets 409 `session_conflict`, where before it got 200.
Decision 1 does not ask for this. Whether `listener/hook.ts:968` replays across a generation change: NOT established.

### 9. RIGOUR — the roster fails completely if the view is missing
`site/src/components/app/LiveDashboard.astro:2029` `if (wakeError) throw new Error(wakeError.message);`. This makes the whole
`roster()` call fail, so a site deployed before the migration, or a rolled-back migration, removes the whole roster, not only the
mark. LANE.md records the release order, but the page should treat a view error as "no mark".

### 10. RIGOUR — the `listen status` sentence says more than was checked
`src/listener/main-routing.ts` `NO_LISTENER_STATUS_SENTENCE` = "No listener is running for this seat…". `src/cli.ts:7343-7353`
checked one instance directory (`paths.instanceDirectory`). A listener that runs with another `--state-dir`, or on another host,
for the same seat makes the sentence false. The old text ("No listener found under <dir>") matched what was checked. The two changed
dispatch rows (`listen.status`, `policy.host-session.listen.status.keep`: `not_found` → `no_listener`) are the intended change,
and `listen stop` keeps `not_found`.

---

## Confirmed as correct (measured or read)
- The widened CHECK narrows nothing. `replied`, `queued` and non-exhausted `failed_terminal` still need the lease pair (real-table probe).
- View `swarm_read.agent_wake_path`: columns are only `workspace_id, principal_id, oldest_unobserved_at`. It is `security_barrier`, owned by
  `swarm_admin`, and selectable by `authenticated`. Member scope comes from `swarm.is_member(d.workspace_id, auth.uid())`. Revoked principals are excluded.
  Plan: index scan on `signal_deliveries_unacked_oldest`, 1.9 ms locally.
- The edge takes the recipient from auth (`index.ts:10362`), so one principal cannot ack another's row. A foreign or absent row gets
  403 `delivery_unavailable` (no existence oracle). A leased row gets 409 (`:752`). A terminal or queued row gets 409 (`:787`). Replay of its own
  unclaimed ack is idempotent. Validation (`index.ts:1706-1708`) accepts `unclaimed` only as `true` together with observed, null lease,
  null listener and `surfaced: true`.
- Ack order in check is structural: `ackPending` reads the COMMITTED `pending_observed_ids`. The profile and `--hook` paths write it with the
  cursor (`agent-check.ts:285`). The MCP path writes it only in the post-write commit (`:276-282`). A failed output never enqueues.
- `WAKE_STALE_MS = IDLE_POLL_MAX_MS * 3`, and `WAKE_STALE_LABEL` is generated. The receipt and roster both import them.
- Focused gates on the archive copy: `tests/delivery-client.test.ts`, `tests/delivery-receipts.test.ts`,
  `tests/p1-cli/{agent-onboarding,mcp-stdio,receipt,hook-routing}.test.ts`: **164/164 pass**, exit 0. All are named or globbed by `npm test`
  or `test:p1-cli`. The site test `wake-path.observer.test.ts` is globbed by the site `test` script.

## Not established
- Production row counts, the size of the attended-seat backlog, and the name of the check9 constraint on the box.
- Whether the server suite passes after the fix in finding 1. I did not run `test:p1-server` because another arm was using the
  shared stack's edge container. The in-process measurement above is on the lane's real code against the real local schema.
- Real `--hook` turn latency against the box.

VERDICT: FAIL

===== GROK REVIEW (round 1) =====
I'll review item G lane 1 as a read-only check against the brief, the design, and the diff at `bb229da9`. No files will be changed and nothing will contact production.The brief, design, and lane record are in place. Next I’ll read the migration, command edge, check path, and the surfaces they change.Item G lane 1 fails. A managed seat’s `check` cannot record `observed`, and the roster mark stays stale for mail `check` will not present. Both ship on the box path (migration `20260925000001` and the command edge).

## PRODUCTION

**1. A managed unclaimed `observed` ack is refused for every freshly enqueued row.** `session_id` is copied onto `swarm.signal_deliveries` only when a lease is claimed:

```360:361:supabase/functions/command/durable-delivery.ts
        session_id = ${sessionId}::uuid,
        session_generation = ${sessionGeneration},
```

Enqueue inserts only `signal_id`, `workspace_id`, and `recipient_agent_principal_id` (`supabase/migrations/20260905000020_wake_all_recipients.sql:162-170`). An attended row therefore has `session_id` null. The new branch still requires the row’s session to equal the proof:

```731:735:supabase/functions/command/durable-delivery.ts
    if (row.last_lease_id !== null || row.last_leased_by !== null) return { status: "conflict" };
    if (managed && (
      args.proof == null ||
      row.session_id !== args.proof.session_id ||
      Number(row.session_generation) !== args.proof.generation
    )) return { status: "session_conflict" };
```

`enforceAgentSessionProof` has already accepted that proof against `swarm.agent_execution_sessions` (`supabase/functions/_shared/agent-auth.ts:254-278`, called for `ack_agent_delivery` at `supabase/functions/command/index.ts:8930-8944`). The row check then returns `session_conflict` and does not update. I called `ackAgentDelivery` with an enqueued-shaped row (`session_id` null, no lease) and proof `{ session_id: "session-a", generation: 2 }`: status `session_conflict`, zero updates.

`check` swallows that failure and retries the same id (`src/cloud/agent-check.ts:254-266`). The receipt and `swarm_read.agent_wake_path` stay unobserved. The design’s control is this path: `cswarm check --profile … --host-session-id …`.

The unit control never uses that row. It pre-loads `session_id: "session-a"` (`tests/delivery-client.test.ts:985-1008`), so the named fence test passes (3/3 focused tests passed here) without proving an enqueued row. `tests/p1-server/managed-delivery.test.ts:587-602` posts an ask and expects HTTP 200 for the current proof; that assertion does not match this function. `docs/evidence/2026-09-25-item-g-lane1/LANE.md:8` says the edge accepts the ack when the managed proof matches the row. An untouched row has no session to match. `LANE.md:20` does say that server suite was not run.

**2. The roster mark is the oldest unobserved directed row, and `check` does not ack that set.** The view is `min(d.enqueued_at)` over every unacked, never-leased directed ask or note, with no `s.until` predicate:

```54:65:supabase/migrations/20260925000001_unclaimed_observed_ack.sql
CREATE VIEW swarm_read.agent_wake_path WITH (security_barrier = true) AS
SELECT d.workspace_id, d.recipient_agent_principal_id AS principal_id,
       min(d.enqueued_at) AS oldest_unobserved_at
FROM swarm.signal_deliveries AS d
...
WHERE d.acked_at IS NULL AND d.lease_id IS NULL AND d.leased_by IS NULL
  AND d.last_lease_id IS NULL AND d.last_leased_by IS NULL
  AND s.kind IN ('ask', 'note')
```

`check` only queues ask/note ids from the page after the local cursor (`src/cloud/agent-check.ts:181-185`, `239`). The read defaults `includeStale` to false (`src/cloud/signals.ts:1620`, sent at `1200`). The read edge drops `s.until <= statement_timestamp()` unless `include_stale` (`supabase/functions/read/index.ts:897`). Expiry of an unclaimed row runs inside `claimAgentInbox`, which an attended seat does not call (`supabase/functions/command/durable-delivery.ts:237-266`). Purge deletes only rows with `acked_at IS NOT NULL` (`supabase/migrations/20260731000001_signal_deliveries.sql:247-248`).

Asks default to a 7-day TTL (`supabase/functions/command/index.ts:647-649`). A directed ask that was never claimed stays in the aggregate after the inbox hides it, so the badge cannot clear. Seats that already have a `check` cursor also leave every older live row unacked. On release, a seat that checks on time still shows `Wake path stale`. The same aggregate is what the app polls every 30 seconds (`site/src/components/app/LiveDashboard.astro:2025-2028`, `5790-5802`); `signal_deliveries_unacked_oldest` leads with `recipient_agent_principal_id`, not `workspace_id` (`supabase/migrations/20260731000001_signal_deliveries.sql:79-86`).

## RIGOUR

**3. `signal_deliveries_check9` admits a second new shape.** On PostgreSQL 17 the auto-name `signal_deliveries_check9` is the lease-pair check, and this migration’s `DROP`/`ADD` replaces that definition. Lease-free `replied` and lease-free `failed_terminal` with any other error still violate it. Lease-free `observed` with `last_error_code = 'provider_refused'` is accepted. The new predicate is `ack_outcome = 'observed'` with no error-code conjunct (`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:23-29`). The edge update does not write `last_error_code` (`durable-delivery.ts:753-760`). The replacement is one transaction and the new predicate is a superset, so the validation scan cannot reject current rows; it does hold `ACCESS EXCLUSIVE` on `swarm.signal_deliveries` for that scan, the same shape as `20260828000003`.

**4. Hook observation can run past the process deadline.** `ackPending` builds one `DeliveryCommandClient` whose `deadlineMs` is the time left at batch start, capped at `AGENT_CHECK_TIMEOUT_MS` (3900). Each `post` starts a new timer of that full duration (`src/cloud/delivery.ts:833-836`) after the loop has already passed `Date.now() >= deadlineMs` (`src/cloud/agent-check.ts:241-256`). The host hook ceiling is 5 seconds (`src/cloud/agent-check-budget.ts:1-29`). A request that starts near the deadline can still be in flight when `runTurnHook` writes its failure line (`src/onboarding-cli.ts:108-111`, `139-141`), after the messages were already printed.

**5. The functional proof is not pinned to the seeded note.** It takes the oldest matching delivery in the whole table and accepts `oldest_unobserved_at <= v_oldest` (`deploy/release-proofs/item-g/20260925000001-functional.sql:12-36`). On a database that already has unclaimed directed mail, that proof passes without reading the seeded row, and a view that reports an older timestamp still passes. An empty table still raises `no seeded directed unclaimed delivery for wake-path view proof`, which is the failure `LANE.md` names. The catalog `\gset` boolean does fail if `min(d.enqueued_at)` is absent.

## Clauses that hold

The edge’s unclaimed branch is a separate `unclaimed: true` shape, limited to directed ask/note for the authenticated recipient, idempotent when the row is already lease-free `observed`, and it returns `conflict` for a current lease, a `last_lease_*` pair, or any other `ack_outcome` (`durable-delivery.ts:709-787`). Another principal’s delivery is not that row (`recipient_agent_principal_id` in the `FOR UPDATE`). H0 rejects an unknown `unclaimed` field (`supabase/functions/h0/parse.ts:237-241`). `check` acks only presented ask/note ids, after the cursor commit, and for MCP only after `rawSend` (`src/mcp/server.ts:19-28`, `84-94`). Failures are swallowed. The queue is capped at 200 and each check attempts at most 20 (`src/cloud/agent-check.ts:34`, `240`, `260`). The selected host-session proof is what `bindSessionProof` attaches. Receipt text, `WAKE_STALE_LABEL`, and `listen status` `no_listener` match decision 4; the dispatch baseline changes only `listen.status` and `policy.host-session.listen.status.keep`, both exit 0. The view returns `workspace_id`, `principal_id`, and `oldest_unobserved_at`, with `security_barrier` and `swarm.is_member`. Those client and copy tests are on `npm test`, `test:p1-cli`, `test:p1-server`, or `npm --prefix site test`.

VERDICT: FAIL
