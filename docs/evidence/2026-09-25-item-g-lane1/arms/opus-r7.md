# Item G lane 1, round 7: Opus exact review of `ec44cc95..a1a3fd74`

Arm: exact review (Anthropic family). Worktree: detached at `a1a3fd74469600e032e87d4e35a22b44d15cc68b9`.
Probes: `scratchpad/itemG/opus-r7-probes/`. I changed no repo file. Every SQL probe ran in a transaction that I
rolled back. I contacted no production host.

## Scope

`git diff --stat ec44cc95..a1a3fd74` shows 14 files: the catalog proof (index clause), `LANE.md`, the catalog test,
and 11 new files under `docs/evidence/2026-09-25-item-g-lane1/index-probe/`.

**The index is unchanged.** `git diff --quiet ec44cc95 a1a3fd74 -- supabase src` exits 0. The migration still says
(`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:59-61`):

```
CREATE INDEX signal_deliveries_unclaimed_observed
  ON swarm.signal_deliveries (workspace_id, recipient_agent_principal_id)
  WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL;
```

The local stack has that index, valid (`indisvalid = t`).

## Check 1: the read-edge probe (R6-F1). Fixed.

`LANE.md:16` now gives this body:

```
{"resource":"signals","workspace_id":"<test workspace>","inbox":true,"about":null,"kind":null,"since":null,"in_reply_to":null,"after_created_at":null,"after_id":null,"limit":50,"include_stale":false}
```

**Validator.** `supabase/functions/read/index.ts:289-310` has the key set
`resource, workspace_id, inbox, about, kind, since` + `in_reply_to` (when present) + `after_created_at, after_id`
(as a pair) + `limit, include_stale`. The LANE body has exactly those 11 keys. Each value passes its type check:
`inbox` boolean; `about`, `kind`, `since` and `in_reply_to` null; both cursor values null (`:327-333`);
`limit` 50 is in `1..100` (`:334-336`); `include_stale` boolean. `chatReadKeys` adds `channel` only when that key is
present (`_shared/channels.ts:399-400`). The body is the same shape the CLI sends (`src/cloud/signals.ts:1180-1200`).

**Measured** on the local served read edge (`127.0.0.1:54321` only). I pulled the body out of `LANE.md` with a
regex, put in a random v4 UUID for the placeholder, and sent it with a well-formed unknown agent token
(`swm_agt_` + 43 × `A`). See `read-edge-shape.out`:

```
lane-exact -> 401 {"error":"unauthenticated"}
minus-about -> 400 {"error":"invalid_request"}
plus-extra -> 400 {"error":"invalid_request"}
limit-101 -> 400 {"error":"invalid_request"}
minus-in_reply_to -> 401 {"error":"unauthenticated"}
```

The LANE body passes `parseBody` and reaches the token lookup (`:471-491`). The three 400 controls use the same
token, endpoint and config file. So the probe can tell a valid shape from an invalid one.

**Order.** The new order is: migration, command and read edges, observed ACK, new directed note, probe, functional
proof. That matches `deploy/RELEASE-TO-BOX.md:1276-1291`, where the first note is posted, ACKed, and then the second
note becomes the seed. The probe now runs after the seed exists.

**"`signals` must contain the note's id."** With an agent token, the read edge filters to rows addressed to that
seat (`read/index.ts:890-896`) and to live rows (`:897`). With a null cursor, `cursor_mode` is true, so `orderAsc`
is true (`:819-820`). The query pages oldest first with `LIMIT 50` (`:928-933`). The seed is the newest directed
signal. It is on page 1 only if the seat has 50 or fewer live directed signals. The stated precondition,
"fewer than 50", is enough. "A fresh test seat holds two" matches section 6: two directed notes, and an ACK is a
command, not a signal.

- A wrong `workspace_id` gives 200 with `signals: []` (`:504-534`), so the probe fails closed.
- Port 9000 publishes the edge runtime directly (`deploy/edge-runtime/compose.yaml:32`), so no `apikey` header is
  needed.
- The read edge needs no session-proof headers, even for a managed seat. `managed_at` is only reported (`:751`).

**"A raw read does not ACK."** This is true. The only writes on the agent read path are
`agent_delivery_read_context`, which updates `swarm.agent_tokens.first_used_at` and the predecessor's `expires_at`,
and `record_renewal_grant_use`. Neither one touches `signal_deliveries`. So the seed stays eligible for
`20260925000001-functional.sql`.

Not measured: a 200 response carrying a real note id. That needs a committed seat and token on the shared stack,
and the brief lets me write only inside rolled-back transactions.

## Check 2: the catalog proof's exact index clause (R6-F2). Fixed.

`deploy/release-proofs/item-g/20260925000001-catalog.sql:77`:

```
SELECT pg_get_indexdef(i.oid) = 'CREATE INDEX signal_deliveries_unclaimed_observed ON swarm.signal_deliveries USING btree (workspace_id, recipient_agent_principal_id) WHERE ((ack_outcome = ''observed''::text) AND (last_lease_id IS NULL) AND (last_leased_by IS NULL))'
```

I ran the proof file byte for byte (with its `\gset`) in 11 rolled-back cases (`catalog-cases.sql` / `.out`). Each
case also ran a control copy, `proof-no-indexdef.sql`, which swaps only that comparison for `true`. When the full
proof returns `f` and the control returns `t`, the index clause alone decided the result.

| Case | full proof | proof without indexdef clause |
|---|---|---|
| installed | t | t |
| index dropped | f | f (no row in the COALESCE, so it still fails closed) |
| test case: extra `acked_at IS NULL` conjunct | **f** | t |
| test case: `UNIQUE (..., signal_id)` | **f** | t |
| r6: `OR` predicate (accepted by the old LIKE) | **f** | t |
| reversed column order | **f** | t |
| `INCLUDE (signal_id)` | **f** | t |
| `recipient_agent_principal_id DESC` | **f** | t |
| no predicate | **f** | t |
| dropped then recreated exactly (positive control) | t | t |

After the run, `leftover_wrong = 0` and `index_present = 1`. The r6 case "unique 2-column" could not be built:
local data has duplicate keys. My first run stopped there and the session rolled back (`catalog-cases-run1.out`).
I removed that case and ran again.

**The test's wrong-index cases reach the index clause.** `tests/p1-server/managed-delivery.test.ts:964-980` pairs
the new cases with `view`, which is the installed view body. Their names contain `"index"` and no other case name
does, so the `DROP INDEX` guard (`:970`) fires only for the three index cases. Each case uses the same DDL as my
probe. The table above shows the proof without the index clause returns `t` for both test cases, so the other
clauses pass and `f` comes only from the index comparison. `npm run check:tests` (with a temporary HOME) exits 0.
The lead's `r7-managed.log` shows 23/23 and "section 5 catalog proof accepts the installed view and refuses an old
heal rule". I did not rerun the served suite; the brief reserves the stack for the lead.

`pg_get_indexdef(oid)` always names the table with its schema. Under `SET LOCAL search_path = swarm, public` it
printed the same string.

## Check 3: claims and file references added in a1a3fd74

| Claim (`LANE.md`) | Result |
|---|---|
| :158 "the lead's saved run took 1599 ms (`index-probe/lead-base.out`)" | True: `Execution Time: 1599.382 ms`. |
| :158 "280 ms, both lookups on the index (`lead-idx.out`)" | True: 280.099 ms; `observed` and `later` both use `Index Scan using signal_deliveries_unclaimed_observed`. |
| :158 "61, 50 and 51 ms … heal lookup on the index once and on a sequential scan twice (`lead-migrated-*.out`)" | True: 61.113 / 49.992 / 51.138 ms. In run 1 `later` is a Bitmap Index Scan on the index; in runs 2 and 3 it is `Seq Scan on signal_deliveries later`. The known-seat lookup is on the index in all three. |
| :158 "Opus's two runs took 262 and 282 ms (`opus-r6-migrated-*.out`)" | True: 262.275 / 281.674 ms. The files match my r6 `view-cost-{1,2}.out` except for trailing spaces. |
| :158 "built the index on a 1,000,000-row copy in 39 ms (8 kB; `build-cost.out`)" | True: `CREATE INDEX … Time: 39.030 ms`, `8192 bytes`, `matching_rows 0`. |
| :158 "each rolled back, `leftover: 0`" | True: every `.out` has exactly one `leftover: 0`. |
| `roster-cost.sql`, `roster-cost-with-index-in-probe.sql` | Byte-identical to the lead's scratchpad `idx-probe/base.sql` and `idx.sql`. |
| :162 two wrong indexes each return `f` | True (measured above). |
| :163 outputs copied to `index-probe/` | True: 11 files. |
| :16 "A null cursor pages oldest first" | True (`read/index.ts:819-820`). |

**Secrets.** I grepped the 14 changed files for `swm_`, JWT prefixes, `postgres://`, `password`, `service_role`,
`secret`, `sk-`, `token_hash` and long hex strings. There are no hits in the evidence files. The hits in the test file
are environment variable names and values generated at run time that were already there. The probe outputs hold
only synthetic UUIDs and plans.

## Findings

### F1. RIGOUR (minor): a direction reference that is wrong again

`LANE.md:164` (R5-F4 row): "the lead corrected both (see R6 below)". The R6 rows are at `:161-163`, above this row.
This is the same kind of slip R6 flagged ("below" for "above"). No reader action goes wrong.

### F2. RIGOUR (minor): two statements say more about required keys than the edge enforces

- `LANE.md:161`: "The first read-edge probe body lacked `workspace_id`, `about`, `kind`, `since` and `in_reply_to`,
  so the read edge answers 400". The key `in_reply_to` is optional (`modernShape`, `read/index.ts:289,306`). The LANE
  body without it gets 401, not 400 (`minus-in_reply_to` above). The 400 came from the other four keys.
- `LANE.md:16`: "(the read edge refuses a missing or extra key)". This is not true of `in_reply_to` (it can be
  left out) or `channel` (it can be added). It is true of every other key.

The body LANE gives is valid either way, so this has no effect on the release. It is claim precision only.

### Note (not a finding, outside this diff): the view clauses depend on search_path

Under `SET LOCAL search_path = swarm, public`, the proof returns `f` on the installed catalog even without the index
clause. `pg_get_viewdef` then prints `is_member(...)` without its schema, so the clause
`LIKE '%swarm.is_member%'` (`catalog.sql:31`) fails. This fails closed and predates this commit. The box runs the
proof through `release_psql_ro` (`RELEASE-TO-BOX.md:572-590`). Locally, the `postgres` and `supabase_admin` roles
have `"$user", public, …`. I did not establish the box connection role's `search_path`. If it contains `swarm`, the
section 5 proof would stop a good window. `SET LOCAL search_path = pg_catalog` at the top of the proof would remove
the dependency (`verify-h0-poll-catalog.sql:3` does this).

Cosmetic: `index-probe/build-cost.out:23` has the line "unterminated quoted string". My r6 `\echo` had an
apostrophe in it. The SQL statements after it ran; the timings are unaffected.

## Not established by me

- A 200 response from the read edge with a real note id. I measured validator acceptance (401 after the token
  lookup) and reasoned about the query from code.
- The served server suite at `a1a3fd74`. I relied on the lead's `r7-managed.log` (23/23). `npm test` and
  `test:p1-cli` were not rerun, because `src/` did not change.
- The box: the connection role's `search_path`, row counts, plan choice, and index build time.

## Ruling

R6-F1, R6-F2 and R6-F3 are fixed, and I measured each fix.

- The probe body passes the read edge's validator, and it runs after its note exists.
- The exact index clause returns `t` on the installed catalog and `f` for every wrong index I tried.
- Both wrong-index test cases fail on the index clause alone.
- Every new timing claim and file reference matches the committed outputs.
- The index is unchanged.

The two remaining findings are minor precision errors in history rows and a parenthetical. They do not change any
step an operator runs.

VERDICT: PASS
