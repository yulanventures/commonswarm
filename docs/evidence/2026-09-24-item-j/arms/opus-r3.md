# Item J (option A) — Checker review, Claude Opus arm, round 3 (delta)

Subject: `lane/item-j` from `a1ef90ff` to `281595e0`.
- Fold 2: d609b9b7 fix, 28555194 tests, 90467bbf evidence.
- 281595e0: the lead's comment correction and observer assertion.
- Rulings: `scratchpad/itemJ/fold2.md` F1-F5.

Copies under test: `git archive 90467bbf` at `opus-probes-r3/` and `git archive 281595e0` at
`opus-probes-r3b/`. `npm run build` exit 0. 281595e0 changes only two site files, so every SQL, proof
and CLI result below applies to the new tip unchanged.

Evidence: `scratchpad/itemJ/opus-work/`
- `cases2.sql`, `r3-mut/*.sql|.log`, `r3-server-*.log`
- `r3-{issuer,gate,space,fold1}.sql`
- `r3-layout/` (fixture builder plus the 1200/600px layout JSON)

Scope and cleanup:
- I used the local stack only. The installed `md5(prosrc)` = `03e8130f…`. That equals the lane
  file's body and the digest pinned in the catalog proof, so the lead's reset applied fold 2.
- Every SQL change I made ran in a rolled-back transaction. Ten table counts are identical before and
  after the server runs (`209|291|291|319|265|493|293|277|67|269`).
- No `opus*` row or schema is left, no tracked file changed, and all my scratch mutations are
  restored byte-for-byte.
- No process of mine is running. The headless Chrome still running belongs to the `anvil` profile,
  not to me.

---

## F1 — a departed issuer's join code is not listed: PASS

`20260924000001_pending_access.sql:95` `AND issuer_membership.user_id IS NOT NULL`.

`cases2.out` rerun (rolled back):

| code | result |
|---|---|
| J6, issuer's membership revoked, unexpired, 0/2 | **gone** |
| J1 live 0/1, live issuer | stays |
| J5 1/3, live issuer | stays |
| J2 revoked, J3 expired, J4 used up | hidden |

The classic rows and access control are unchanged from round 2: 7 rows for the owner and for a
plain member, and 0 rows for a revoked member, another workspace, an outsider, archived or random
workspace ids, and a caller with no claims. The server fixture has an issuer-left code. Mutant N19
(drop the predicate) is killed at the row-count assertion.

## F2 — both proofs can fail, each for its stated reason: PASS

I ran both proofs locally in the runbook §5 form:
`PGOPTIONS=-c default_transaction_read_only=on` and `psql -X --set=ON_ERROR_STOP=1`, with the catalog
proof inside the §5 wrapper tail.

| run | result |
|---|---|
| catalog, installed | `t`, exit 0 |
| functional, installed | `DO`, exit 0 |
| catalog, issuer gate dropped (rolled back) | `f` |
| catalog, member gate `IF false` | `f` |
| catalog, one trailing space added (whitespace-only body change) | `f` |
| catalog, fold-1 body (`a1ef90ff`) | `f` (was `t` in round 2) |
| functional, member gate `IF false` | `ERROR: pending access returned rows without a member identity` |
| functional, zero pending rows (every principal and code revoked in a rolled-back tx; 294 live members kept) | `ERROR: no seeded pending row visible to a live member …` |

So each proof fails for the reason it claims:
- the catalog proof on a changed body;
- the functional proof on a removed member gate;
- the functional proof on zero rows.

The CLI test recomputes the md5 of the migration body and requires the catalog proof's constant to
match it, so an edit to one without the other fails the test.

Operational note, not a defect: the functional proof now needs a pending row for a live member on
the box before the window. The README says HezLead seeds it through the product path. A join code
lives 24 h at most, so the seed must be fresh.

## F3 — the members read and the four app reads are pinned: PASS

- **CLI:** I reverted `runMembers` (`src/cli.ts:4286`) to the throwing `readPendingAccess`. The test
  "the members command itself uses the nonthrowing pending read" fails (6 pass, 1 fail). In round 2
  this same mutation passed 91/91.
- **Site:** I reverted each of the four real call sites to a direct `pendingAgentAccess(...)`:
  `workspaceId` #1 (poll refresh), `workspaceId` #2 (roster refresh), `selected.id` (open), and
  `activeWorkspaceId` (post-add refresh). Each one alone fails the observer (23 pass, 2 fail).
  In round 2, the two `workspaceId` mutations passed.
- The check reads the call sites from the TypeScript AST of the script and requires exactly 4. It
  does not use a typed list.

## F4 — Pending access is visible at every width, and nothing else moves: PASS

CSS diff:
- `.dashboard__roster-dialog-pending` changes from `display: none` to the same four declarations
  (`display: grid; gap; padding-block-start; border-block-start`) that the removed
  `@media (max-width: 52rem)` block carried.
- No other selector changes.
- The empty state stays hidden because of the global `.dashboard [hidden] { display: none !important }`
  (`LiveDashboard.astro:9404`). The roster dialog is inside `<live-dashboard class="dashboard">`
  (lines 30-1116), so that rule applies to it.

Rendered measurement. I rendered the real dashboard markup and the full global style block of both
`a1ef90ff` and `90467bbf` in headless Chrome, with the roster dialog open, and compared all 366
elements. `281595e0` changes only a template comment here, which does not render.

| case | elements that differ |
|---|---|
| 1200px, section `[hidden]` (nothing pending) | **0 of 366** |
| 600px, section shown | **0 of 366** |
| 1200px, section shown | 6 of 366 |

The 6 differences at 1200px are the pending section and its 3 children (`display: none` → `grid`,
376×38 at 412,1045), and the dialog and dialog body, which grow 50px in height to hold it. Nothing
else moves.

Tests:
- The rendered test (600px and 1200px) passes on this host.
- Mutation M1 (the round-2 state: base `display:none` plus a narrow-only `grid`): the geometry test
  fails ("1200px pending section must be visible"). At 90467bbf the source observer passed M1 (25/25),
  because its regex also matched the grid rule inside the media query. The new assertion in
  **281595e0** fixes that: M1 now fails the observer too (24 pass, 1 fail).
- Mutation M2 (a desktop-only `@media (min-width: 52.01rem)` rule with `display:none` not written
  first): the observer passes (25/25). Only the rendered geometry test fails it.

So the rendered test is the complete control and the observer covers the likely regression. The
geometry test fails, rather than skips, when there is no Chrome (`findChrome` throws), so a host
without Chrome cannot pass it silently.

The 281595e0 markup comment is now true. The rail's pending markup does not exist, and I confirmed
that on `origin/main` in round 2.

## F5 — LANE.md: PASS, with two stale lines (RIGOUR, doc)

The fold-1 "not installed" note is gone, and the post-apply update is recorded. The CLI evidence test
guards this. Two lines are wrong:
1. `docs/evidence/2026-09-24-item-j/LANE.md` has the heading `## Fold 2 — 2026-09-24` twice in a row.
2. "Fold 2 not established: The Fold 2 function is not yet installed in the lead's local stack…" is
   stale now. The lead's reset installed it (md5 `03e8130f…`), and the normal server test passes 1/1.

This is the same stale-note pattern as F5, one fold later. Fix it in the evidence commit.

## Findings

### 1. RIGOUR (low): in source mode, the digest assertion now hides which behavior assertion catches a mutant

`tests/p1-server/pending-access.test.ts:228` runs the catalog proof, which includes the body digest,
before the clearing section. In my rerun of 20 source-mode mutants, all 20 are killed and the
positive control passes. But four mutants now die only at the digest line instead of at the
behavior assertion that caught them in round 2:
- N10 seat cap (was line 242)
- N13 principal revoked (was 242)
- N17 eleventh column (was 217)
- N20 whitespace only

The behavior assertions are unchanged, so nothing is lost today. A future mutation run, however,
can no longer show those assertions discriminate. Moving the catalog-proof assertion to the end of
the test, or skipping the digest in source mode, would restore that signal.

### 2. RIGOUR (doc): LANE.md

The two stale lines under F5 above.

No PRODUCTION finding. Gates I ran on 281595e0:

| gate | result |
|---|---|
| build | 0 |
| check:edge | 0 |
| check:tests | 0 |
| CLI pending + citation | 8/8 |
| site access-lifecycle + header-roster + agent-row-geometry, rendered, real Chrome | 40/40 |
| server test, normal mode (90467bbf; same SQL at 281595e0) | 1/1 |
| server test, source-mode baseline | 1/1 |

## Not established

- I did not run the full `npm test`, `test:p1-cli`, site `test` or `build-release.sh`. The lead
  reports those gates.
- The app in a live signed-in browser session. My layout check used the real markup and CSS in a
  static fixture.
- Proof behavior under the box's `PGSERVICE=target` role. My local runs used `postgres`.
- Production data and query plans.

VERDICT: PASS
