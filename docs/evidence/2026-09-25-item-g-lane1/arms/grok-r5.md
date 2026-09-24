I'll review lane 1 at `c61ae4a7` against the brief and the round-4 failures, without changing files or touching production. First I'll read the spec, the evidence record, and both diffs.The round-4 fix touches the catalog proof, the read-edge order, the heal, and the evidence record. I'll read those paths in full and compare them to every caller that pages or validates that order.No defects. The millisecond check order is the same key in the read edge, the cursor, the client comparator, and the heal. The catalog proof returns true on the installed view and false on each bad view. The cutoff test isolates the cutoff. K1, K2, and I1–I4 still hold, and the box steps match the release procedure.

**1. Check order.** The key is `(date_trunc('milliseconds', created_at), id)` in every place that pages or heals.

The read edge orders with that key in both directions, and the after-cursor predicate uses the same truncation and then `id`:

```912:932:supabase/functions/read/index.ts
          -- JSON timestamps only carry millisecond precision, while Postgres
          -- stores microseconds. Truncate both sides so a client cursor built
          -- from a prior page's created_at cannot re-include that last row.
          ${useAfterCursor} = false
          OR date_trunc('milliseconds', s.created_at) >
            date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
          OR (
            date_trunc('milliseconds', s.created_at) =
              date_trunc('milliseconds', ${afterCreatedAt}::timestamptz)
            AND s.id > ${afterId}::uuid
          )
        )
      -- Order by the cursor's own key. ...
      ORDER BY
        CASE WHEN ${orderAsc} THEN date_trunc('milliseconds', s.created_at) END ASC,
        CASE WHEN ${orderDesc} THEN date_trunc('milliseconds', s.created_at) END DESC,
        CASE WHEN ${orderAsc} THEN s.id END ASC,
        CASE WHEN ${orderDesc} THEN s.id END DESC
```

`cursor_mode` forces ascending order (`read/index.ts:820`), and the after-predicate runs only then (`:823-827`). A cursor page cannot be descending.

`compareSignalCursor` is `Date.parse` then `id` (`src/cloud/signals.ts:613-621`). `Date.parse` keeps millisecond precision. postgres.js 3.4.9 parses `timestamptz` with `new Date`, which truncates extra fractional digits the same way `date_trunc('milliseconds')` does, and `JSON.stringify` emits `toISOString()`. Callers that accept or reject a page use that comparator: `sortSignals` / `rowsAfterCursor` (`signals.ts:633-656`, applied at `:1270-1272`), check's monotonic walk (`agent-check.ts:219-220`), and the cursor commit (`agent-check.ts:321`). Follow and the listener advance with `nextCursor` from the last raw row (`signals.ts:1277-1279`, `listener/runtime.ts:2276-2278`). With this order, that row is the greatest `(millisecond, id)` on the page.

The heal uses the same tuple:

```99:100:supabase/migrations/20260925000001_unclaimed_observed_ack.sql
      AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)
        > (date_trunc('milliseconds', s.created_at), s.id)
```

`id` is unique, so the keyset is a total order. The predicate is strict `>`. A same-millisecond pair is returned once on every cursor page of this query (check, MCP `check` via `checkAgentMessages`, follow, listener, arrival after its baseline). The served test posts the higher id at +100µs and the lower id at +900µs and requires one-row pages `[low, high]` (`tests/p1-server/managed-delivery.test.ts:798-831`). Reverting the `ORDER BY` to microseconds makes page 2 empty, because the cursor is already millisecond-truncated and the lower id is not greater.

Other readers of this statement:

- The home feed and channel pages in the web app use PostgREST `created_at DESC, id DESC` (`LiveDashboard.astro:2316-2322`), not this `ORDER BY`.
- H0 orders by `enqueued_at` (`h0/poll-ack.ts`).
- `since` is still `created_at >=` at full precision (`read/index.ts:908-910`).
- `in_reply_to` still forces ascending (`:820`). Within one millisecond the tie-break is `id`, which matches the cursor.
- Descending one-shot windows (agent feed, hook, arrival baseline) now take the greatest `(millisecond, id)`. Arrival's baseline stores that row as the high-water (`arrival-watch.ts:671-676`), so a same-millisecond neighbor is already behind the cursor instead of being emitted later as new.
- Index use is unchanged on the query that runs. On the local database, both the old and new `ORDER BY` against `swarm_read.signals` are an index scan on `signals_workspace_newest` plus a sort. `date_trunc` is only the sort key.

The commit-order skip is still open, as `LANE.md:169` and the cursor task say. It is a different skip (a later commit with an earlier `created_at`), not the millisecond one.

**2. Catalog proof.** On the local database, inside a transaction that was rolled back, the installed view returns `catalog_ok = t`. Recreating the view with an enqueue-order heal, a microsecond tuple, no later kind filter, or no release cutoff each returns `f`. After rollback the installed view still has `date_trunc('milliseconds', later_signal.created_at)`. Section 5 runs this file and commits only when `catalog_ok` is `t` (`deploy/RELEASE-TO-BOX.md:937-947`). The pinned text is the millisecond row comparison:

```54:57:deploy/release-proofs/item-g/20260925000001-catalog.sql
      AND pg_get_viewdef(v.oid) LIKE '%d.enqueued_at >= ( SELECT wake_path_release.applied_at%'
      AND pg_get_viewdef(v.oid) LIKE '%ROW(date_trunc(''milliseconds''::text, later_signal.created_at), later_signal.id) > ROW(date_trunc(''milliseconds''::text, s.created_at), s.id)%'
      AND pg_get_viewdef(v.oid) LIKE '%later_signal.kind = ANY%'
      AND pg_get_viewdef(v.oid) NOT LIKE '%later.enqueued_at > d.enqueued_at%'
```

The one-argument `pg_get_viewdef` is the compact form, and that is the form the proof calls. It matches.

**3. Cutoff test.** `tests/p1-server/managed-delivery.test.ts:976-996` posts two asks, moves `applied_at` to after both, and observes the older one. The known-seat predicate still passes, because that acknowledgement's `acked_at` is after the new cutoff (`migration:85-90`). The older acknowledgement is earlier in `(millisecond, id)`, so the heal does not hide the newer ask. The only remaining exclusion is `d.enqueued_at >= applied_at` (`migration:77`). The rolled-back view with that one line removed must return exactly the newer id. That is the cutoff.

**4. Earlier rulings.** K1 still heals only a later unclaimed observed ask or note, now in the millisecond key. K2 still prunes retry metadata to queued ids (`agent-check.ts:81-84`). I1's private view, ACLs, and both dependents are still what the catalog checks (the measured `t` includes them). I2's cutoff is the load-bearing guard above, not a redundant one. I3's functional proof still reads `swarm.wake_path_eligible_deliveries` (`20260925000001-functional.sql:21-28`). I4 adds no index. Reverting the heal to enqueue order fails the inverted-recipient test; dropping the kind filter fails the non-ask/note test; each catalog mutation above returns `f`; a microsecond `ORDER BY` empties page 2 of the same-millisecond test; a microsecond heal makes the second ask ineligible.

**5. Release text.** `LANE.md:17` says apply `20260925000001`, then release the command and read edges, then the seeded note and functional proof, and only then npm and the site. Section 5 applies the migration and the catalog proof in one transaction. Section 6 recreates the one edge runtime, which is the command and read functions from that SHA, and runs the functional proof only after that edge is up (`RELEASE-TO-BOX.md:1276-1292`). The roster-tolerates-a-missing-view and no-deploy-on-merge sentences are unchanged and still match the code. The lead-fold controls match the tests. The commit-order skip is recorded as open, not as fixed.

VERDICT: PASS
