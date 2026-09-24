Fold 2 on item J (option A, ruled by the Strategist) in the CommonSwarm repo, branch lane/item-j at a1ef90ff. Spec:
docs/design/2026-09-24-ITEM-J-INVITED-NOT-CONNECTED-BRIEF.md. Round 2: Grok PASS, Opus PASS with findings (pasted at
the end). The lead rules that these are fixed before the box release. Implement EVERY ruling with a test (or a proof)
that fails when the fix is reverted; record rulings and mutation results in docs/evidence/2026-09-24-item-j/LANE.md
under "Fold 2". Read AGENTS.md ("a probe that cannot fail proves nothing") and deploy/RELEASE-TO-BOX.md.

HARD RULES: as for fold 1 — no production host; never run a cswarm command without a loopback --url; no remote
supabase command; no db:reset or db:stop; do not touch ~/.cswarm or ~/.config/cswarm; no other model; no skill; no
auto-approve flags; print no secret; every test has a timeout; no process survives. You may edit the lane's migration.
Commit yourself: "fix(pending): ..." / "test(pending): ...", trailers exactly (one per line): Agent-Name: Yulan Bot /
Agent-Model: <your model id> / Agent-Family: openai / Agent-Tool: codex <version> / Agent-Model-Source: runtime-ambiguous.

RULINGS
F1 (Opus 2). A join code whose issuer is no longer a member cannot be used (403): do not list it (`AND
   issuer_membership.user_id IS NOT NULL` or equivalent). Server test case; mutation recorded.
F2 (Opus 4). The box-release proofs must be able to fail: the catalog proof checks the function body as well as its
   shape (for example a digest of pg_proc.prosrc compared with the migration's body, or the presence of each filter
   predicate), and the functional proof's member check asserts a real bound (a non-member gets exactly 0 rows AND a
   member of the workspace gets at least one seeded row), never `v_count < 0`. Show each proof failing on a mutated body
   or gate (record how), in the form RELEASE-TO-BOX.md section 5 requires.
F3 (Opus 1). Tests that fail if `cswarm members` or any of the four app call sites goes back to the throwing read:
   enumerate the call sites from the source (AST or a single exported loader that every site must import), not a typed
   list; mutation: restoring the throwing read at one site fails.
F4 (Opus 3, lead ruling: in scope, because it defeats J's done-test). The app's Pending access section must be visible
   at desktop widths (wider than 52rem) as well as narrow ones. Find the CSS that hides it, fix it without changing other
   layout, and add a site test at a desktop width and a narrow width (use the existing geometry/observer patterns).
F5 (Opus 5). LANE.md: remove the stale "not installed" note; record that the revised function was applied to the lead's
   local stack by db:reset and passed the server suite; list every fold-2 change.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; npm run check:edge ; bash scripts/build-release.sh ; npm --prefix site run build ;
env -u FORCE_COLOR npm --prefix site test ; git diff --check origin/main...HEAD. Name sandbox failures. The lead runs
db:reset and the server suite after your fold.

REPORT: commit SHAs; each ruling -> change -> test/proof -> mutation; gates; not established.

===== OPUS REVIEW (round 2) =====
# Item J (option A) — Checker review, Claude Opus arm, round 2

Subject: `lane/item-j` at `a1ef90ff` (7837e384 + a1ef90ff on c26b98a7). Rulings: `scratchpad/itemJ/fold1.md` J1-J7.
Copy under test: `git archive a1ef90ff` at `scratchpad/itemJ/opus-probes-r2/`. `npm run build` exit 0.
Evidence: `scratchpad/itemJ/opus-work/` (`cases2.sql/.out`, `r2-mut/*.sql|.log`, `r2-server-base.log`,
`r2-members-*.log`, `r2-check-*.log`, `wrap-tail.sql`). Probe scripts: `opus-probes-r2/opus-{edge,cli}-probe.mts`
and `opus-guard.mjs`.

Scope:
- I used the local stack only. The installed function's `md5(prosrc)` = `0566b977…`, which equals the
  lane file's body, so the lead's reset applied the revised migration.
- The CLI ran behind a guard that blocks non-loopback fetches. It blocked nothing.
- I created only uniquely named rows, and I rolled back or deleted all of them. Every table count is
  the same before and after (`workspaces 239, auth.users 341, join credentials 151`), and no `opus*`
  schema is left.
- No tracked file changed. My scratch mutations of `src/cli.ts`, `pending-access.ts` and
  `LiveDashboard.astro` are byte-identical to `a1ef90ff` again. No process of mine is running.

---

## Rulings: measured

**J1 SQL: PASS.** From `cases2.out`, owner reading workspace A in one rolled-back transaction:

| case | result | issued / expiry |
|---|---|---|
| P01 no token | listed | issued = `created_at` (20 h), expiry null |
| P02 one unused token | listed | 2 h / +22 h |
| P03 three tokens, one used | hidden | |
| P04 revoked principal | hidden | |
| P05 expired only | hidden | |
| P06 revoked only | hidden | |
| P12 revoked + expired, none live | hidden | |
| **P07 revoked sibling (10 h) + live (2 h, +46 h)** | **listed** | **2 h / +46 h** (live token, not dead) |
| **P08 expired sibling (12 h) + live (3 h, +45 h)** | **listed** | **3 h / +45 h** |
| P09 two live tokens (8 h/+16 h and 1 h/+71 h) | listed | **1 h / +71 h** (newest issued) |
| P10 owner's membership revoked (J7) | **hidden** | |
| P11 archived workspace, PB other workspace | not in A | |
| J1 live 0/1, J5 1/3 | listed | seats shown |
| J2 revoked, J3 expired, J4 2/2 | hidden | |
| registrars R1-R6 | never listed | |

Access control is unchanged from round 1:
- A plain member of A gets the same 8 rows as the owner.
- These readers get 0 rows: a revoked member, owner B, an outsider, owner A on workspace B, owner A on
  an archived workspace, a random workspace id, and a caller with no claims.
- `anon` gets `permission denied for schema swarm_read`.
- EXECUTE grants: authenticated t, swarm_read t; anon, swarm_command, service_role and authenticator f.

Edge re-probe (`opus-edge-probe.mts`): all 21 results are the same as round 1. Human and agent reads
work, another workspace gets an empty envelope, malformed input gets 400, no bearer gets 401, GET gets
405, a revoked agent gets 403, and first use clears the seat.

**J1 site: PASS.** `git diff origin/main a1ef90ff -- site/src/lib/pending-access.ts`:
- The per-token loop is byte-unchanged. The server rows are added after it.
- A server classic row is skipped when that principal already has a live, unused per-token row, so a
  principal is never listed twice.
- In `LiveDashboard.astro` `buildRows`, the Cancel button code is the same as on main. It is only
  wrapped in `if (row.kind !== "pending")`, and the DOM order (copy, then button) is the same.
- Mutation check: I restored the round-1 early-return `pending-access.ts`. The observer test then
  fails 1/24, at the check that expects the old `Model not specified · owned by Owner · expires …` line.

**J2: PASS.** I built 18 SQL mutants (`r2-mut/`) and ran each one through the lane's own
`CSWARM_PENDING_ACCESS_SOURCE` mode. Every run is rolled back.
- Positive control first: the unmodified file in source mode exits 0.
- All 18 mutants fail. I read the caught inner assertion for each one; none fails from a SQL error.

| mutant | kills at test line |
|---|---|
| N01 drop used-token anti-join | 188 (row count) |
| N02 lateral keeps revoked | 188 |
| N03 lateral keeps expired | 188 |
| N04 oldest live token | 198 (age) |
| N05 drop owner-membership gate (J7) | 188 |
| N06 list dead-only principals | 188 |
| N07 hide no-token principals | 188 |
| N08 drop registrar filter | 188 |
| N09 drop `is_member` gate | 230 |
| N10 drop seat cap | 242 |
| N11 drop join expiry | 188 |
| N12 drop join revoked | 188 |
| N13 drop principal revoked | 242 |
| N14 drop principal workspace filter | 188 |
| N15 drop join workspace filter | 188 |
| N16 locator in `issuer_display` | 205 |
| **N17 an 11th output column `code` (locator)** | **217 (exact ten-name check)** |
| N18 expiry from a dead token | 202 |

My two round-1 survivors (revoked-token and expired-token filters) are now N02, N03 and N06, and all
three are killed. The column check is exact: `test.ts:217` does a deepEqual of the ten `proargnames`.

**J3: PASS.** The server test in normal mode, against the installed function, passes 1/1. Row counts
for workspaces, users, auth.users, memberships, devices, principals, runs, tokens, join credentials
and auth.identities are identical before and after the run (`239|341|341|366|401|917|429|335|151|319`).
All 18 mutant runs also left the counts unchanged.

**J4: PASS.** `deploy/release-proofs/item-j/` has the same form and location as `deploy/release-proofs/h0/`.
The catalog file ends in its own `\gset` of `catalog_ok`, and the functional file is a DO block. I
could run both locally in the document's form: `PGOPTIONS=-c default_transaction_read_only=on`,
`psql -X --set=ON_ERROR_STOP=1`, and the §5 wrapper tail.
- Catalog on the installed function: `t`.
- Catalog after the function is dropped (the "before migration" state): `f`.
- Catalog with an extra column (N17): `f`.
- Catalog with an EXECUTE grant to anon: `f`.
- Functional on the installed function: exit 0.
- Functional with the member gate removed (N09): `ERROR: pending access returned rows without a
  member identity`, exit 3.

**J5: PASS.** CLI, measured end to end on the local edge (`opus-cli-probe.mts`). The guard forced the
`pending_access` read to fail as 404, as 500 and as a network error:
- Each time, `cswarm members` exits 0 and still lists People and Agents.
- The text says `Invited, not connected: could not load`.
- `--json` has `pending: null` and `pending_error: "could not load"`, with members still present.

With no forced failure, the text, the ages (1d / 1h / 7m), the ten JSON keys, and clearing on first
use are unchanged from round 1. The output contains no locator, hash, bearer or registrar.

In the app, all four call sites use `loadPendingAccess` (`LiveDashboard.astro:5705, 6212, 9113, 9157`).
The failure note and the header door are wired in (`:1111`, `:2178-2180`, `:4011`). LANE.md states
the release order.

**J6: PASS.** The migration adds no index, and LANE.md records the measurement.

**J7: PASS.** P10 is hidden (above), and N05 is killed.

**Gates I ran:**

| gate | result |
|---|---|
| build | exit 0 |
| check:edge | exit 0 |
| check:tests | exit 0 |
| CLI pending + citation tests | 6/6 |
| site access-lifecycle + header-roster observers | 37/37 |
| server test, normal mode | 1/1 |
| seven members-related CLI files | 91/91 |

---

## Findings (none PRODUCTION)

### 1. RIGOUR: the J5 wiring in `runMembers` is not under test

`src/cli.ts:4286`: `const pending = await readPendingAccessOptional(`

I mutated this line back to the throwing `readPendingAccess`. Then:
- `tests/p1-cli/pending-access.test.ts` still passes 5/5.
- The seven CLI files that exercise members (item-i-profile-binding, agent-connection-token,
  check-budget, message-formatting, agent-channel, command-dispatch-baseline, pending-access) still
  pass 91/91 (`r2-members-mut.log`).

So the tests cover the helper and `renderRoster(null)`, not the fallback in the members command.
LANE.md says "client mutations of both fallbacks … each exited 1", which is true only for the helper.
My live probe shows the wiring works today. The fix is one test that runs `members` with a fetcher
that returns 404 for `pending_access`.

The site has the same gap. I reverted the two call sites that use `workspaceId` (`:5705` poll refresh,
`:9113` roster refresh) to the throwing read, and the observer tests still pass 37/37. The test pins
only the `selected.id` call site (`access-lifecycle.observer.test.ts`, the new J5 test).

### 2. RIGOUR (low): a join code whose issuer has left is still listed, but it cannot register a seat

`supabase/migrations/20260924000001_pending_access.sql`, join branch: `LEFT JOIN swarm.memberships AS
issuer_membership … revoked_at IS NULL`. This join has no gate like the classic branch's
`owner_membership.user_id IS NOT NULL`.

Case J6 in `cases2.out` (issuer's membership revoked, code unexpired, 0/2 seats) is listed as
`issued by Workspace member`. But `register_agent_seat` refuses such a code with 403
(`command/index.ts:5988`, `lockJoinCredentialOwnerMembership`). This is the same kind of false
"Invited, not connected" claim that J7 fixed for classic seats. The fix is one line
(`AND issuer_membership.user_id IS NOT NULL`) plus a fixture row.

### 3. RIGOUR (pre-existing, outside this diff): the app has no pending surface above 52rem

This comes from reading the source; I did not check it in a browser.
- On `origin/main` and on `a1ef90ff`, the rail's `[data-access-details]` / `[data-access-list]`
  markup no longer exists: the JS references it, but no element has it.
- `.dashboard__roster-dialog-pending { display: none; }` (`LiveDashboard.astro:11356`) is overridden
  only inside `@media (max-width: 52rem)` (`:11519`).

So above 52rem, neither the old token rows, nor the new "Invited, not connected" rows, nor the
"could not load" note can be seen. This lane did not cause it. But the brief's done-test ("the seat
shows invited-not-connected within one minute" in the app roster) cannot pass at desktop width.
The lead should rule on it before calling item J done.

### 4. RIGOUR (low): the release proofs check shape, not behavior

- The catalog proof checks owner, security definer, stability, search_path, the ten names and the
  grants. It does not check the body. The round-1 body (`c26b98a7`), applied in a rolled-back
  transaction, returns `t`. This is harmless in practice, because only this body can reach the box
  ledger.
- In the functional proof, the member check `IF v_count < 0` cannot fail. The negative check (no rows
  without a member identity) proves something only if the first live membership's workspace has
  pending rows. It did on this stack, but that is not guaranteed on the box.

### 5. RIGOUR (doc): LANE.md "Fold 1 not established" is now stale

It says "The revised function is not installed in the lead's shared local stack: its normal server
test currently fails". After the lead's reset, the revised function is installed (md5 above), and the
normal-mode server test passes 1/1 here.

## Not established

- I did not observe the app in a browser: not the rows, not the note, not the one-minute clearing.
- I did not run full `npm test`, `test:p1-cli`, site `test` or `build-release.sh`. The maker's
  sandbox results are in LANE.md.
- Production data and query plans.
- I read the proofs' behavior under the box's actual `PGSERVICE=target` role from code only. My local
  runs used the `postgres` role.

All seven rulings are delivered and measured, the SQL has no surviving mutant, and nothing I found is
a production defect. Findings 1-2 are small test and SQL follow-ups. Finding 3 is a pre-existing gap
for the lead to rule on.

VERDICT: PASS
