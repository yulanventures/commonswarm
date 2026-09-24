I'll review lane 1 at `a3736201` against the brief and `LANE.md`, without changing files or touching production. First I'll read the spec, the lane record, and both diffs.Fold 4 and the lead's fixture commit are small. I'll read that diff first, then the eligibility view and the tests that claim to control it.The lane fails. The fold-4 heal matches check's `(created_at, id)` order for rows the inbox can return, and the retry queue stays inside the pending ids, but the catalog proof still demands the old enqueue comparison, so the box release gate rejects this migration.

## Findings

**PRODUCTION** — `deploy/release-proofs/item-g/20260925000001-catalog.sql:54`. Section 5 requires `catalog_ok` to be `t` (`deploy/RELEASE-TO-BOX.md:1001`). The proof still requires the pre-fold-4 heal:

```54:54:deploy/release-proofs/item-g/20260925000001-catalog.sql
      AND pg_get_viewdef(v.oid) LIKE '%later.enqueued_at > d.enqueued_at%'
```

The view compares signal order instead:

```99:99:supabase/migrations/20260925000001_unclaimed_observed_ack.sql
      AND (later_signal.created_at, later_signal.id) > (s.created_at, s.id)
```

On the local stack, inside a transaction that was rolled back, `pg_get_viewdef` of `swarm.wake_path_eligible_deliveries` is `ROW(later_signal.created_at, later_signal.id) > ROW(s.created_at, s.id)`. Every other catalog conjunct is true (constraint, roster, member gate, private ACLs, receipt function, inner-function revoke). `catalog_ok` is false only because that `later.enqueued_at` fragment is absent. Anvil's `test "$CATALOG_AFTER" = t` stops the release. `docs/evidence/2026-09-25-item-g-lane1/LANE.md:20` says a rolled-back run of the final migration returned `t`. That is false for this tree.

**PRODUCTION** — `supabase/functions/read/index.ts:917-922` and `supabase/migrations/20260925000001_unclaimed_observed_ack.sql:99`. Check does not page in raw `(created_at, id)`. The read edge drops microseconds, then compares `id`:

```917:922:supabase/functions/read/index.ts
          OR date_trunc('milliseconds', s.created_at) >
            date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
          OR (
            date_trunc('milliseconds', s.created_at) =
              date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
            AND s.id > ${afterId}::uuid
```

`JSON.stringify` of the timestamp keeps milliseconds, and `compareSignalCursor` uses `Date.parse` (`src/cloud/signals.ts:617`). A page that ends at `12:00:00.000100` with a high UUID omits a signal at `12:00:00.000900` with a lower UUID. That omitted signal is later in the heal's full `(created_at, id)` order, so an observed ack of any still-later directed ask/note removes it from `swarm.wake_path_eligible_deliveries`. The receipt then takes the ordinary pending sentence (`src/cloud/receipts.ts:172-179`) because `wake_path_observing` is false. The seat never saw the row. On one page, the same pair makes check throw `check_page_order_invalid` (`src/cloud/agent-check.ts:219-220`) and send no ack. The lane records this at `docs/design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md:3-8` and `LANE.md:130`. The heal still hides the skipped row.

The other K1 probes do not add a second hide:

- Equal `created_at` ties on `id` in both the view and `ORDER BY s.created_at, s.id`. The skip above is a sub-millisecond difference, which the page predicate treats as equal time.
- A second profile can ack a later signal: the unclaimed update never writes `session_id` (`supabase/functions/command/durable-delivery.ts:753-761`), and a null row binding accepts any current managed proof (`731-735`). The roster is one row per principal, so that ack means this seat has checked past that point.
- Broadcasts stay out. Eligibility and the heal both require an ask/note and either `to_agent_principal_id` or a `signal_recipients` row (`migration:80-84` and `:100-105`). Check's inbox uses the same directed set (`read/index.ts:846-851`, `src/cloud/signals.ts:468-476`).

The late-recipient fixture is a faithful model of a row production can hold. `signal_recipients_same_transaction` refuses an insert after the signal's transaction commits (`supabase/migrations/20260905000010_signal_recipients.sql:124-133`). The test disables it (`tests/p1-server/managed-delivery.test.ts:707`) because `postAsk` has already committed, and the comment calls the row historical. A normal post still inserts the signal, then each recipient in a later statement (`supabase/functions/command/index.ts:8809-8821`). Position 1+ is enqueued by `enqueue_recipient_delivery` at that later `statement_timestamp()` (`supabase/migrations/20260905000020_wake_all_recipients.sql:205-214`). The same-transaction trigger allows that insert. A concurrent signal can commit between those statements, leaving an earlier `created_at` and a later `enqueued_at` for the same recipient. The `(created_at, id)` rule is what keeps an observed ack of that earlier signal from hiding the later ask. Replacing the tuple with `enqueued_at` fails that test, as measured.

## Checks that hold

**K2.** `queuedRetries` keeps retry entries inside the queued ids on read and on every write (`src/cloud/agent-check.ts:81-85`, `:163`, `:274`, `:330`, `:335`). The queue is capped at 200. Backoff is `min(60_000, 250 * 2^min(attempts-1, 8))` (`:292-293`) and rows older than 24 hours are dropped (`:285-287`). Ack runs after `present`, and failures are swallowed (`:349-351`). Under a temporary `HOME`, the eight observation tests in `tests/p1-cli/agent-onboarding.test.ts` passed, including the 205-id cap. Replacing `queuedRetries` with a whole-map copy leaves `rows[0]` in `pending_observed_retries` after the cap, which fails `retry metadata belongs only to queued ids`.

**I1–I4.** The private view is still the only eligibility source; the receipt wrapper reads it after the author check (`migration:141-150`); the roster adds `swarm.is_member` (`:115`). A nonmember read is empty in `managed-delivery.test.ts:663-671`. Private SELECT and inner EXECUTE are revoked; those catalog conjuncts are true on the local stack. The cutoff guard remains, with no separate cutoff test claimed. The functional proof reads `swarm.wake_path_eligible_deliveries` (`deploy/release-proofs/item-g/20260925000001-functional.sql:21-27`). Missing and ineligible seeds raise, and the member-gate mutations now replace the `WHERE` clause (`managed-delivery.test.ts:981-993`). No index was added.

**Controls.** The later-ask ack test expects the older id to leave the view (`managed-delivery.test.ts:685`). Removing the `NOT EXISTS` heal leaves it in. The kind filter is what keeps an observed `working-on` from healing (`:742-772`); `agent_delivery_is_wakeable` only enqueues ask/note, and the unclaimed command refuses anything else (`durable-delivery.ts:736-749`), so that fixture is a manufactured row and the filter matches the command. I did not re-run `managed-delivery.test.ts`.

**Release text, aside from the catalog.** `deploy/RELEASE-TO-BOX.md:1002-1007` skips this version's functional proof in section 5. After the edge is up, section 6 posts one directed note, acks it unclaimed `observed` on loopback `127.0.0.1:9000`, posts a second note, and passes that UUID as `item_g_seed_signal_id` (`:1276-1292`). That sequence matches fold 2 in `LANE.md`. It never gets there while section 5 requires `catalog_ok = t`.

VERDICT: FAIL
