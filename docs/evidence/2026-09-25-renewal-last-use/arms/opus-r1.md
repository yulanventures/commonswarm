# D-036 exact-review arm (Anthropic family) — lane/renewal-last-use at e1cfd84c

Reviewed: `git diff 5d603b8e..e1cfd84c` (merge-base = 5d603b8e; 4 files, +485, commits 94f08252, e1cfd84c).
Worktree: `.../scratchpad/arms-rlu` detached at e1cfd84c5704b23c3158046fe1b1b99d7b7c3dec.
Probes: `.../scratchpad/itemRLU/opus-r1-probes/` (all SQL ran inside `BEGIN … ROLLBACK`; the final
catalog proof after all probes still returns `t`). No commit, no production host, no server suite run,
no `supabase functions serve` started (it would replace the lead's edge-runtime container).

## Check 1 — replaced functions, trigger, writer coverage

**Line-by-line comparison against the latest prior definitions** (`20260904000001_standing_grant_resume.sql`;
no migration after it touches either function — `grep` of all migrations from 20260904 onward):

- `record_renewal_grant_use`: `diff` of 20260904000001:333-371 against 20260925000002:5-42 shows ONE
  changed line (probe `old-rec.sql`/`new-rec.sql`):
  `<   SET last_used_at = statement_timestamp(),`
  `>   SET last_used_at = GREATEST(grant_row.last_used_at, statement_timestamp()),`
  Signature, `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = swarm, pg_catalog`, predicates,
  `last_used_device_id`, `last_used_from`, `new_host_at` CASE, OWNER, REVOKE and GRANT are byte-identical.
- `agent_tokens_successor_fence`: `diff` of 20260904000001:373-531 against 20260925000002:45-202 shows ONE
  changed line (139): `last_used_at = statement_timestamp(),` → `last_used_at = GREATEST(last_used_at, statement_timestamp()),`.
  OWNER, `REVOKE ALL … FROM PUBLIC`, and the COMMENT are identical.
- Live catalog (lane migration applied): recorder `swarm_admin | prosecdef t | {"search_path=swarm, pg_catalog"} |
  {swarm_admin=X, swarm_command=X, swarm_read=X}`; fence `swarm_admin | f | {search_path=pg_catalog} | {swarm_admin=X}`.
- Trigger `renewal_grants_spend_or_revoke_only()` is not in the diff; its last definition is
  20260904000001:133-240 (REWOUND rule at :165-169 unchanged).

**Writer coverage — enumerated, not pattern-matched.** Live catalog:
`SELECT … FROM pg_proc WHERE prosrc ILIKE '%last_used_at%'` returns exactly six functions:
`swarm.agent_tokens_successor_fence`, `swarm.prepare_renewal_grant`, `swarm.record_renewal_grant_use`,
`swarm.renewal_grants_spend_or_revoke_only`, `swarm_read.renewal_grant_for_token`, `swarm_read.renewal_grant_roster`.
Only the two replaced ones assign it (prepare reads it at 20260904000001:283; the trigger checks it; the two
`swarm_read` functions project it). `supabase/functions`: `last_used_at` does not appear; the only
`UPDATE swarm.renewal_grants` statements in `command/index.ts` set `successors_stranded + 1` (:3789) or
`revoked_at` guarded by `AND revoked_at IS NULL` (:4427, :4436, :4494). Both edges reach the recorder only
through `SELECT swarm.record_renewal_grant_use(…)` (`read/index.ts:535`, `command/index.ts:10930`).
Coverage is complete.

**new_host_at / last_used_device_id under the race.** EPQ re-evaluates the SET list on the committed row, so
`new_host_at` is decided from B's committed `last_used_device_id` / `new_host_at`, exactly as a serial run
would. `last_used_device_id` / `last_used_from` are still overwritten by the waiting statement, while
`last_used_at` stays B's. For the callers that exist today this is identical to before (see finding 1 for
the case where it is not).

## Check 2 — GREATEST under READ COMMITTED re-check

Both edges run the recorder inside `db.begin("isolation level read committed", …)` (`read/index.ts:445`,
`command/index.ts:8902`, `:11061`). Under RC, a blocked UPDATE re-fetches the newest committed version and
re-runs the qual and target-list projection on it (EvalPlanQual), so `grant_row.last_used_at` inside
`GREATEST` is B's committed value. `GREATEST` ignores NULL, so a first use still stamps
(`residual.out`: first call succeeded on a NULL row). The lead's passing test is itself the empirical
proof: it asserts the final value equals B's stamp (test:136); if the projection had used A's snapshot, the
result would be `tA < tB` and the trigger would raise REWOUND.

The successor fence locks the row `FOR UPDATE` (:139-142) before its UPDATE, and the INSERT statement's
`statement_timestamp()` predates that wait, so the same clamp is needed there; it is present (:183).

Other trigger-guarded columns: `successors_used`/`successors_stranded` are `+ 1` (EPQ-safe);
`suspended_at` write is guarded by `suspended_at < statement_timestamp()` in its WHERE
(20260904000001:292-294), so a stale statement skips rather than rewinds; `resumed_at` is written only after
`FOR UPDATE` + `suspension_active` re-check (20260904000001:~560-612), and a second resume returns
`renewal_grant_not_suspended`; `revoked_at` writers are `IS NULL`-guarded; `new_host_at` is written only
when NULL. No other guarded column is rewound by this race.

## Check 3 — the test

- Part 1 (`tests/p1-server/renewal-last-use.test.ts:99-137`) is a real reproduction: B takes
  `FOR UPDATE` (:104-105), A's call is sent (:108), the test polls A's own backend pid for
  `wait_event_type = 'Lock'` (:112-124) and asserts it before B calls the recorder (:126) and commits. A's
  statement start therefore precedes B's. On the old body A gets REWOUND and :133 fails; the lead measured
  that. Positive-control shape is sound.
- Part 2 (served read, :139-201) uses the real `read` edge with an agent token, a `members` read in the
  principal's own workspace (reaches :535), same lock order, and requires HTTP 200 plus B's stamp. See
  findings 2 and 3 for its limits.

## Check 4 — catalog proof

Ran `deploy/release-proofs/renewal-last-use/catalog.sql` on the local stack; each mutation inside a
rolled-back transaction (`mut-*.sql` / `mut-*.out`):

| State | Result |
|---|---|
| installed (lane migration applied) | `t` |
| old 20260904 recorder body reinstalled | `f` |
| old 20260904 fence body reinstalled | `f` |
| no-rewind trigger disabled | `f` |
| `EXECUTE` revoked from `swarm_read` | `f` |
| positive control: lane migration text re-applied in a txn | `t` |
| after all probes (rolled back) | `t` |

The proof discriminates as claimed. (Minor: see finding 5.)

## Check 5 — box safety

The migration is two `CREATE OR REPLACE FUNCTION`s, `ALTER FUNCTION … OWNER`, `REVOKE`/`GRANT`, `COMMENT`.
No `ALTER TABLE`, no table lock on `renewal_grants`/`agent_tokens`, no data rewrite. Replacing a function
takes a row lock on its `pg_proc` tuple only; in-flight calls finish on the old definition and the next
call uses the new one (plpgsql cache invalidation). Same statements as prior migrations, same owner.
Idempotent on re-run. Safe to apply while traffic runs.

## Findings

1. **RIGOUR (latent, not reachable by current callers)** — `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql:17-19` (and :183-184).
   When the waiting statement's row already carries a newer `last_used_at`, `GREATEST` leaves it unchanged
   while `last_used_device_id = p_device_id` / `last_used_from = COALESCE(p_last_used_from, …)` still change;
   the trigger rule at 20260904000001:170-176 (`… AND NEW.last_used_at IS NOT DISTINCT FROM OLD.last_used_at`)
   then raises `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` (55000). Measured in a rolled-back txn
   (`opus-r1-probes/residual.out`): row newer than statement + same device + NULL from → success, value kept
   (`t|t`); + different device → `ERROR: SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP`; + non-NULL from → same error.
   Today both edges pass `NULL` for `last_used_from` (`read/index.ts:538`, `command/index.ts:10933`) and the
   token's run device (runs' `device_id` is never updated; a grant's tokens share its run), so the race stays
   same-device/NULL-from and the fix holds. A future caller that passes a `last_used_from` value, or a
   second device on one grant, turns the same race back into a 500 with a different code. Record it in
   LANE.md as a known limit (or clamp device/from with the timestamp in a later lane).
2. **RIGOUR** — `docs/evidence/2026-09-25-renewal-last-use/LANE.md:17,35`. The record still says the
   mutation is "reasoned, not executed" and that the server race tests "have not been run". The lead has
   since measured pass at e1cfd84c and REWOUND (55000) with the old body. The correction must land in the
   artifact, with the command and counts, before the lane lands.
3. **RIGOUR** — `tests/p1-server/renewal-last-use.test.ts:133` vs `:139-201`. On the old body the test
   stops at :133, so the served part has never run against the old body; LANE.md:17 "the served read returns
   500" is not measured. Also its block detector (:179-182) matches any backend whose query text contains the
   call and waits on any `Lock`, not this grant row (acceptable under `--test-concurrency=1`, not proof).
4. **RIGOUR (flake risk)** — `tests/p1-server/renewal-last-use.test.ts:154`: `Date.now() + 10_000` boot
   deadline for `supabase functions serve`; all 12 sibling server tests use 60 s (e.g.
   `standing-grant-resume.test.ts:212`). A cold edge-runtime start can exceed 10 s and fail the gate for a
   reason unrelated to the fix; the 45 s test timeout (:50) also leaves little margin.
5. **RIGOUR (minor)** — `deploy/release-proofs/renewal-last-use/catalog.sql:17-22`. For the fence the proof
   checks body digest and owner only, not `proconfig` (`search_path=pg_catalog`) or its ACL; `prosrc` does not
   cover either. Low risk because the migration sets both, but the proof does not attest them.

No PRODUCTION finding. The fix is the minimal one-line change in each of the only two writers, it is
correct under READ COMMITTED re-check, the catalog proof discriminates, and the migration is lock-light.

## Not established by this arm

- The concurrent two-session race was not re-run here: B must commit for A to see its row, and the brief
  requires every SQL session to roll back. I used a single-transaction stand-in (row newer than the next
  statement) and rely on the lead's measured pass/fail for the concurrent form.
- The served-edge part was not run (it would start `supabase functions serve` against the lead's stack).
- Whether the box currently has 20260925000001 applied (ordering prerequisite) was not checked; no box access.

VERDICT: PASS
