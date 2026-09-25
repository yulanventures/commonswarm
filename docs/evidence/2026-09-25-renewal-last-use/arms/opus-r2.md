# D-036 exact-review arm (Anthropic family), round 2: lane/renewal-last-use at d36e6d65

Reviewed: `git diff e1cfd84c..d36e6d65` (Fold 1: 5 files, +343 -176) and the whole lane `git diff 5d603b8e..d36e6d65`
(5 files, +652). Worktree `.../scratchpad/arms-rlu`, detached at d36e6d65, clean.
Probes: `.../itemRLU/opus-r2-probes/`. Every SQL probe ran inside `BEGIN … ROLLBACK` (savepoints for the negative
controls). After all probes: the catalog proof returns `t` and no `aaaaaaaa…`/`bbbbbbbb…` probe grant rows exist. I
ran no server suite, started no `functions serve`, contacted no host, ran no cswarm command, and wrote only this file
and the probe folder. The only process I started was the pure contract test (`node --test` on one file, exit 0, 2/2).

## Check 1: stale-use skip under the READ COMMITTED re-check; spend exactly once

**Recorder** (`supabase/migrations/20260925000002_renewal_last_use_monotonic.sql:17-37`). The stale test is in the
WHERE clause of the UPDATE on the target relation:

```
    AND (grant_row.last_used_at IS NULL
         OR grant_row.last_used_at <= statement_timestamp());
```

Under READ COMMITTED, a blocked UPDATE re-checks the WHOLE qual on the newest committed version of the target row
(EvalPlanQual). The row's `last_used_at` now comes from the committed later use, so the qual is false and the row is
skipped (0 rows, no trigger call). The function returns `void` and no caller reads the row count
(`read/index.ts:535-539`, `command/index.ts:10929-10935`), so a skip is a silent no-op. The lead's concurrent test
`older SQL use with another device and source…` passed at d36e6d65 (`gates-r2.log:310`). That is the empirical proof
of the re-check.

Single-session stand-in with the installed body (`residual-r2.sql/.out`): the row's `last_used_at` is set one hour after
the next statement's start, device `d2`, from `newer`:

| Case | Installed d36e6d65 body | Same call, round-1 GREATEST body | Same call, 20260904 body |
|---|---|---|---|
| [R1] stale, same device, NULL from | no error; row unchanged (`0|t|t|newer|t`) | — | — |
| [R2] stale, other device, from `older` | no error; row unchanged (`0|t|t|newer|t`) | `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` | `SWARM_RENEWAL_LAST_USE_REWOUND` |

So the round-1 residual (my R1 finding 1) is closed. The negative controls use the same invocation in the same
transaction.

**Successor fence** (`:142-201`). The fence takes `FOR UPDATE` on the grant row (`:142-145`). Under RC, that returns the
newest committed version after the wait, so `grant_row` and every check after it (revoked, suspended, horizon, device
binding, `successors_used - successors_stranded >= max_successors` at `:165-169`) see the committed row. The spend is now
its own unconditional UPDATE on the row this transaction holds locked (`:186-188`, one row, no EPQ). The use-field
UPDATE (`:190-201`) re-reads the row after the spend (same transaction, later command) and skips if the row is newer
than the INSERT statement's start. The trigger allows an increment with no timestamp change: the only rule that ties
the timestamp to other fields is `USE_WITHOUT_TIMESTAMP` (20260904000001:170-176), which looks at device/from only.

Measured (`fence-stale-r2.sql/.out`, stale row as above):

| Case | Result |
|---|---|
| [F1] stale successor, standing grant | INSERT succeeds; `successors_used` 0→1; `last_used_at`, device `d2`, from `newer`, `new_host_at` NULL all kept |
| [F2] stale successor, timeboxed grant `max_successors = 1` | succeeds, spend 1, use fields kept |
| [F3] second stale successor on that grant | `SWARM_RENEWAL_GRANT_EXHAUSTED`: the stale spend counts against the ceiling |
| [F4] round-1 GREATEST fence, same INSERT | `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` |
| [F5] 20260904 fence, same INSERT | `SWARM_RENEWAL_LAST_USE_REWOUND` |

Non-stale path (`nonstale-r2.sql/.out`): a first use stamps a NULL row; a later use with another device and a source
stamps the time, device, source and `new_host_at`; a non-stale successor gives `successors_used = 1` (not 2) and
`last_used_at = issued_at`. Existing `command.test.ts:4750` ("exactly one slot consumed"), `:4779`, `:4795` still
pin one spend per successor on the served path. They passed in `gates-r2.log`, so a double-spend mutant (increment in
both UPDATEs) would be caught there, not by the new stale test.

**Other guarded columns.** The two new UPDATEs write only `successors_used` (+1), `last_used_at`,
`last_used_device_id`, `last_used_from` (recorder only), and `new_host_at` (only while NULL). The skip removes every
path where an older statement writes use fields, so REWOUND, USE_WITHOUT_TIMESTAMP and NEW_HOST_REWOUND cannot fire from
this race. Live triggers on `swarm.renewal_grants` are `renewal_grants_server_clock` (BEFORE INSERT),
`renewal_grants_spend_or_revoke_only` (BEFORE UPDATE/DELETE), and `renewal_grants_revoke_cascade` (AFTER UPDATE
`WHEN old.revoked_at IS NULL AND new.revoked_at IS NOT NULL`). The fence's second UPDATE therefore adds no side effect.

**Equal timestamps.** `<=` lets an equal-timestamp write through. This is reachable only within one top-level statement
or on a microsecond collision between sessions. With today's callers the device is the same, so the write is a no-op for
the trigger. This behaviour is unchanged from before the lane. It is not a finding.

## Check 2: each replaced function against its latest prior definition

The latest prior definitions are in `20260904000001_standing_grant_resume.sql` (recorder :333-371, fence :373-531). The
catalog shows `20260925000002` is the newest applied migration. No migration between them touches either function.

- Recorder (`diff-rec.out`). The only change is the WHERE clause: `AND NOT grant_row.suspension_active;` becomes
  `… suspension_active` plus the two-line stale predicate (`:35-37`). The SET list, signature, LANGUAGE, SECURITY
  DEFINER, search_path, OWNER, REVOKE and GRANT are byte-identical. The round-1 GREATEST line is gone.
- Fence (`diff-fence.out`). The only change is the tail: the single `SET successors_used = successors_used + 1,
  last_used_at = statement_timestamp(), …` becomes a spend UPDATE plus a use UPDATE with the stale predicate, and a
  2-line comment is added. `last_used_device_id = run_device` and the `new_host_at` CASE are unchanged. Every check
  above `:184`, OWNER, REVOKE and COMMENT are identical.
- The installed `prosrc` digests equal the migration bodies: recorder `2b6cb7ca…` (R5 in `residual-r2.out`), and the
  catalog proof returns `t`.

## Check 3: tests

- `tests/p1-server/renewal-last-use.test.ts:120-163`. B locks the row with `FOR UPDATE` (:135). A calls with
  `otherDevice`/`'older'` (:138). `waitForGrantLock` requires A's own pid, `wait_event_type = 'Lock'`, bPid in
  `pg_blocking_pids`, and A holding a granted `RowExclusiveLock` on `swarm.renewal_grants` (:91-102). Then B records
  (:143) and commits. The test asserts no error and B's time, device, source, and NULL `new_host_at` (:150-158). On
  GREATEST, A raises USE_WITHOUT_TIMESTAMP at :150; on the 20260904 body, REWOUND at :150. My R2 stand-in reproduces both
  codes. The lead measured the GREATEST failure.
- `:165-217` (successor). The lock wait is tied to A's pid with `RowShareLock` (the fence's `FOR UPDATE`). The test
  asserts spend 1 and B's fields (:208-212). A mutant that skips the whole fence UPDATE fails at :208. GREATEST fails at
  :201 (F4).
- `:219-287` (served). This is now independent of the SQL tests. It has a 60 s boot window (:239) and requires HTTP 200
  and B's timestamp. Its lock check has no waiting pid (the edge backend pid is unknown), but it is tied to the unique
  bPid, the recorder query text, and the relation lock. That is meaningful. It does not tell the fixed body from GREATEST
  (same device, NULL from), and it is not meant to. See finding 2 for what is still unmeasured.
- Round-1 findings 3 and 4 (served part never reached, 10 s boot) and Y2's lock check are closed.

## Check 4: catalog proof

`deploy/release-proofs/renewal-last-use/catalog.sql` was run as a matrix (`catalog-matrix.sql/.out`). Each state was set
up in a rolled-back transaction:

| State | Result |
|---|---|
| installed | `t` |
| recorder 20260904 body | `f` |
| recorder round-1 GREATEST body | `f` |
| fence 20260904 body | `f` |
| fence round-1 GREATEST body | `f` |
| no-rewind trigger disabled | `f` |
| recorder: EXECUTE revoked from swarm_read | `f` |
| recorder: extra EXECUTE to service_role | `f` |
| recorder: search_path gains `public` | `f` |
| recorder: SECURITY INVOKER | `f` |
| recorder: owner postgres | `f` |
| fence: SECURITY DEFINER | `f` |
| fence: EXECUTE to swarm_read | `f` |
| fence: EXECUTE to PUBLIC | `f` |
| fence: search_path `swarm, pg_catalog` | `f` |
| fence: owner postgres | `f` |
| positive control: d36e6d65 migration re-applied | `t` |
| after all probes | `t` (`catalog-after.out`) |

The proof returns `t` only for the fixed bodies with the intended search_path, security, owner and grants. Round-1
finding 5 is closed.

## Check 5: box safety

This is unchanged from round 1. The migration has two `CREATE OR REPLACE FUNCTION`s, OWNER, REVOKE/GRANT, and COMMENT.
There is no DDL on a table, no table lock, and no data rewrite. In-flight calls finish on the old body. The next call
uses the new body. Re-running the file is idempotent (the positive control re-applied it in a transaction). The split
fence UPDATE writes two row versions per successor instead of one, which is negligible. Ordering: it follows
`20260925000001`, and whether the box has that migration is not established by me.

## Findings

1. **RIGOUR**: `docs/evidence/2026-09-25-renewal-last-use/LANE.md:17,23,56`. The artifact still says the GREATEST
   server mutation "is reasoned until HezLead runs it", that "the Fold 1 server tests and catalog proof have not been
   rerun against an installed Fold 1 migration", and that they "remain unmeasured on the local stack". The lead has since
   measured at d36e6d65: `test:p1-server` 264/264 (`gates-r2.log:310-312,325-333`), and the GREATEST reinstall fails the
   two SQL race tests. Also, this arm's catalog matrix is `t` only for the fixed state. The correction must land in
   LANE.md with commands and counts, and the retired wording must be kept, before the lane lands.
2. **RIGOUR**: `tests/p1-server/renewal-last-use.test.ts:219-287` with `LANE.md:17`. The served test is now
   independent (Y2), but no record shows it failing on the 20260904 body. The GREATEST reinstall does not exercise it
   (same device, NULL from, so it passes on GREATEST). So "the served read returns 500 on the old body" is still reasoned,
   not measured. Either run the served test once with the 20260904 recorder reinstalled and record the status, or have
   LANE.md say that this is not measured.
3. **RIGOUR (latent, the reverse of round-1 finding 1)**: `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql:36-37,200-201`
   with `tests/p1-server/renewal-last-use.test.ts:156-158`. A stale use now succeeds and leaves no trace of its own
   device. With `bound_device_id = device`, A uses `otherDevice` and the test requires `new_host_at` to stay NULL. A
   serial run of the same two uses would stamp `new_host_at`. Before the lane, that use failed with a 500 instead.
   Today's edges pass the token run's device (`agent_delivery_read_context` returns `r.device_id`), and a grant's tokens
   share one run, so a stale use cannot carry another device. The test pins the latent behaviour as correct. Record it in
   LANE.md as a known limit (for example, "a stale use from another device is not flagged as a new host").
4. **RIGOUR (minor)**: `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql:210-211`. The unchanged
   COMMENT still says the fence "atomically records spend plus use". After Fold 1 it always records spend, and records use
   only when the row is not newer. The catalog comment makes a claim that is now partly untrue.
5. **RIGOUR (minor)**: `tests/p1-cli/renewal-last-use-contract.test.ts:34-40,43-50`. The "negative control" edits the
   body and asserts that the md5 changed, which cannot fail. The second test asserts the source text of another test file
   (test names, `60_000`, regex fragments). This is implementation-coupled and does not protect behaviour. The digest
   and ACL assertions at :23-33 are the useful part.

No PRODUCTION finding. Fold 1 does what ruling Y1 asks, in both writers. The skip is in the WHERE clause, so the RC
re-check sees the newer row. The successor spends exactly once, and that spend counts against the ceiling (F3). Every
earlier body fails the same invocation. The catalog proof discriminates on body, search_path, security, owner and
grants. The migration is safe to apply while traffic runs.

## Not established by this arm

- The two-session race itself. The brief requires every session to roll back, and B must commit for A's re-check to see
  its row. I used a single-transaction stand-in (row newer than the next statement). For the concurrent form I rely on
  the lead's `gates-r2.log` pass and the lead's GREATEST reinstall failure.
- The served test against any earlier body (finding 2). I did not start `functions serve`.
- Whether the box has `20260925000001` applied. I had no box access.

VERDICT: PASS
