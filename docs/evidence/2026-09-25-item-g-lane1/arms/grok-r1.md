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
