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
