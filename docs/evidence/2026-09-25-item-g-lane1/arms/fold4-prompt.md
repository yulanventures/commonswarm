Fold 4 on item G lane 1 in the CommonSwarm repo, branch lane/item-g-lane1 at b178c470 (your fold 3). Spec:
docs/design/2026-09-24-ITEM-G-LANE-1-BRIEF.md with its corrections. The Grok round-3 review of fold 2 (FAIL) is pasted
at the end; its two findings still apply to your code. Implement both rulings, each with a test that fails when the fix
is reverted; record them in docs/evidence/2026-09-25-item-g-lane1/LANE.md under "Fold 4". Read AGENTS.md first.

HARD RULES: as before — no production host; never run a cswarm command without a loopback --url; no remote supabase
command; no db:reset or db:stop; do not touch ~/.cswarm or ~/.config/cswarm; no other model; no skill; no auto-approve
flags; print no secret; every test has a timeout; no process survives. You may edit the lane's migration. Commit
yourself: "fix(wake): ..." / "test(wake): ...", trailers exactly (one per line): Agent-Name: Yulan Bot / Agent-Model:
<your model id> / Agent-Family: openai / Agent-Tool: codex <version> / Agent-Model-Source: runtime-ambiguous.
Server tests run only on the lead's local stack; write them carefully (acked rows need delivered_at/surfaced_at like the
edge writes; swarm.signals is append-only — use the disable-trigger pattern in tests/p1-server/command.test.ts, and
backdate created_at before until).

RULINGS
K1 (Grok 1, PRODUCTION). The "later observed ack heals older mail" rule must use the SAME order `cswarm check` pages in:
   the signal's (created_at, id) (join swarm.signals), not signal_deliveries.enqueued_at; and only a later observed ack
   of a directed ASK or NOTE counts (kind filter). Keep it in the shared eligibility view. Server tests: (a) a signal
   created earlier but enqueued later (an additional recipient) is NOT hidden by an ack of a signal created later but
   enqueued earlier the wrong way round — build the exact case Grok measured; (b) a later observed ack of a non-ask/note
   kind hides nothing; (c) the intended heal still works; each fails when the corresponding part is reverted.
   Note: the read edge's inbox cursor has a separate same-millisecond skip bug (filed as its own task); do not fix it
   here, but state in LANE.md that the heal rule is only as safe as check's cursor, and link the task.
K2 (Grok 2, RIGOUR). `pending_observed_retries` must never hold ids that are not in `pending_observed_ids`: prune retry
   records whenever ids leave the queue, including ids dropped by the 200 cap. Test: push more than the cap and assert
   the retries map is bounded and a subset of the queue.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; npm run check:edge ; npm run build:command-core && git diff --exit-code
supabase/functions/_shared/protocol.js ; bash scripts/build-release.sh ; npm --prefix site run build ;
env -u FORCE_COLOR npm --prefix site test ; git diff --check origin/main...HEAD. Name sandbox failures.

REPORT: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.

===== GROK REVIEW (round 3, on fold 2) =====
I'll review item G lane 1 at `5c188ac4` against the Fold 2 rulings, without changing files. First I'll read the rulings, `LANE.md`, and the diff from `fad542e0`.HEAD is `5c188ac4`. I'll read Fold 2 in `LANE.md` and the diff from `fad542e0` next, then check each ruling against the code and tests.The fold changes the wake-path SQL, the ack retry path, and the release proof. I'll read those together with the tests that are supposed to fail if a ruling is reverted.The missing-seed proof exits 3, and the old `\quit 1` path still exits 0. Next I’ll probe the later-ack rule in a transaction that rolls back, and rerun the client tests without the color-env warning.Item G lane 1 at `5c188ac4` still fails. The later-observed rule clears a directed row the checking seat has not been shown, and the receipt follows that same predicate. H1’s missing seed now exits 3, and the client retry caps behave as ruled.

## Findings

### 1. PRODUCTION — a later observed ack hides mail the check has not presented

Check walks the inbox by `(created_at, id)`. The wake rule treats a later `enqueued_at` as proof the seat already saw the older row. Those orders differ, and the predicate does not look at session, kind, or channel.

```89:94:supabase/migrations/20260925000001_unclaimed_observed_ack.sql
  AND NOT EXISTS (SELECT 1 FROM swarm.signal_deliveries AS later
    WHERE later.workspace_id = d.workspace_id
      AND later.recipient_agent_principal_id = d.recipient_agent_principal_id
      AND later.enqueued_at > d.enqueued_at
      AND later.ack_outcome = 'observed' AND later.last_lease_id IS NULL
      AND later.last_leased_by IS NULL)
```

```193:196:src/cloud/agent-check.ts
          readAgentSignalPage(target, { kind: "agent", token }, {
            workspaceId: profile.workspace_id, inbox: true, ascending: true,
            limit: AGENT_CHECK_PAGE_SIZE,
            ...(state.cursor === null ? {} : { after: state.cursor }),
```

```612:621:src/cloud/signals.ts
export function compareSignalCursor(
  a: SignalCursor,
  b: SignalCursor,
): number {
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0) return byTime;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
```

A scalar delivery is enqueued in the signal insert, so its `enqueued_at` matches `created_at`. An additional recipient is enqueued by a later statement:

```205:214:supabase/migrations/20260905000020_wake_all_recipients.sql
    INSERT INTO swarm.signal_deliveries (
      signal_id,
      workspace_id,
      recipient_agent_principal_id
    ) VALUES (
      NEW.signal_id,
      NEW.workspace_id,
      NEW.recipient_agent_principal_id
    )
    ON CONFLICT DO NOTHING;
```

On the local database, inside a transaction that rolled back, a signal created at −80 minutes and enqueued at −15 minutes was observed with `session_id` set to another session. A second signal created at −70 minutes (later in check order) and enqueued at −40 minutes stayed unacked. The view omitted it and `wake_path_observing` was false. Check can present and ack the first signal on a page that ends before the second (`AGENT_CHECK_PAGE_SIZE` is 20, and the body budget stops the page). The second signal is then absent from the roster and the receipt.

The same predicate ignores kind. A `working-on` delivery with a later unclaimed-shaped observed ack also cleared an earlier ask (view false, receipt false). Today’s command refuses that ack unless the signal is an ask or a note (`durable-delivery.ts` lines 741–750), so check does not write it. The view would still honor it.

Equal `enqueued_at` stayed visible (view true, receipt true). A listener-shaped observed row with `last_lease_id` set left the older ask visible. A newer unacked row stayed visible. The intended heal (earlier unacked, later observed, same order) cleared both surfaces together.

The inbox cursor can also skip a row the seat never receives. The next page keeps a same-millisecond row only when its id is greater:

```913:923:supabase/functions/read/index.ts
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
```

A one-row page ending at `12:00:00.000100` / `ffffffff-…` drops `12:00:00.000900` / `00000000-…`. That row is later in `(created_at, id)` order and is not on the next page. A signal in the following millisecond can be observed, and its greater `enqueued_at` then removes the skipped row from both wake surfaces.

`tests/p1-server/managed-delivery.test.ts` lines 636–646 only ack the second posted signal, which is later in both orders. Reverting the predicate fails that test. It does not fail for an inverted `enqueued_at`, another session, another kind, or a skipped cursor row.

### 2. RIGOUR — retry metadata grows after the ack queue is capped

`pending_observed_ids` is capped at 200. `pending_observed_retries` is copied whole, and only ids in `removed` are deleted. Ids dropped by the cap keep their retry records for the life of the profile.

```250:269:src/cloud/agent-check.ts
        const directedIds = presented.filter(row => row.kind === "ask" || row.kind === "note").map(row => row.id);
        const pendingIds = [...new Set([...(state.pending_observed_ids ?? []), ...directedIds])].slice(-AGENT_CHECK_CACHE_LIMIT);
        const ackPending = async () => {
          // ...
              const retries = { ...(current.pending_observed_retries ?? {}) };
              for (const id of removed) delete retries[id];
              for (const [id, retry] of retryUpdates) retries[id] = retry;
              if (attempt) retries[attempt.id] = attempt.retry;
```

`readCheckState` rejects an id list longer than 200 and does not cap the retry map (`agent-check.ts` lines 141–149). The file is refused above 16 MiB (`agent-check.ts` line 136), which throws `StoredRecordOversizedError` and fails the check. Backoff itself is capped at 60 seconds (`AGENT_CHECK_ACK_RETRY_MAX_MS`, exponent capped at 8). Acks run after `present`, and failures are swallowed (`agent-check.ts` lines 249 and 339–341), so a failed ack leaves the check result unchanged.

`tests/p1-cli/agent-onboarding.test.ts` passed 25/25 with `FORCE_COLOR` unset and a temporary `HOME`. The deadline test still requires the pre-request persist: a timed-out ack keeps attempt 1 and a future `next_at`, and an earlier 409 in that batch is removed.

## Rulings that hold

**H1.** `20260925000001-functional.sql` lines 6–7 raise `item_g_seed_signal_id is required`. Under `psql -v ON_ERROR_STOP=1` that exits 3. The old `\quit 1` text, run from `/tmp` against the same server, exits 0. An unknown id and a revoked seat also exit 3 with the eligibility exception. A dedicated eligible seed exits 0, then the transaction rolls back. `set_config` for the seed and `request.jwt.claims` succeeds with `default_transaction_read_only=on`, which is how `release_psql_ro` runs. Section 5 skips this version (`deploy/RELEASE-TO-BOX.md` lines 1004–1007). Section 6 runs it after the edge release, with `-v item_g_seed_signal_id`, and `release_psql_ro` forwards that flag (lines 572–589 and 1289–1292).

**H3.** `managed-delivery.test.ts` lines 585–633 move the cutoff to one hour before the rows, set it to `statement_timestamp()` so the four-minute row is excluded, move it back so the row is included, and restore the original value in `finally`. That does not depend on how old the migration’s cutoff is. `WAKE_STALE_MS` is 180 seconds, and the row is backdated four minutes.

**H4.** The migration comment at lines 15–16 says `DROP`/`ADD` holds `ACCESS EXCLUSIVE` through `VALIDATE` and commit. The source-text test that claimed there was no validation lock is gone from `tests/delivery-client.test.ts`. The server test at lines 749–767 loads 100,000 rows and asserts `AccessExclusiveLock` is still held after `VALIDATE`. `LANE.md` records 9.6 ms on that local copy and says the box window is not established.

**H5.** `signal_delivery_receipts` sets `wake_path_observing` from `swarm_read.agent_wake_path_deliveries` (migration lines 126–130). In the rolled-back probe the receipt bit matched the view on every case, including the false clear. The catalog proof requires the function body to name that view.

**H6.** The renamed function is revoked from `PUBLIC`, `anon`, `authenticated`, and `swarm_read` (migration lines 110–112), matching `20260902000002_attended_receipt_queue.sql` lines 7–9. On the local catalog all four `has_function_privilege` checks are false and the owner is `swarm_admin`.

**H7.** The file-regex tests for the constraint, the proof, and the view are removed. The replacement server tests call the local database. The H4 comment check reads the migration file and also reads `pg_locks`.

No production host was contacted. The visibility probe rolled back (`probe-owner` count 0). The full reset-stack server suite was not run.

VERDICT: FAIL
