# Item J, option A — maker evidence

Branch: `lane/item-j` from `e9fe4fe8`. This lane prepares a change; it has not
landed on `main`, been applied to the box, or been observed live.

## Decisions and implementation

1. One server-owned pending list: `supabase/migrations/20260924000001_pending_access.sql`
   adds `swarm_read.pending_access(uuid)`. It checks live workspace membership,
   enumerates ten output columns, and derives classic principals (including no
   token yet) plus available join credentials. Registrar principals are excluded.
   Issuer display comes from a current membership, with a generic fallback.
   The function grants execute to `authenticated` and `swarm_read`, and denies
   `anon`. The read edge serves `resource: "pending_access"` to a human session
   or a scoped agent credential, with an empty envelope for another workspace.
2. The app's two existing Pending access lists use the new resource on opening
   a workspace and on their existing bounded poll. The row says “Invited, not
   connected · <age>”. A classic token can still be cancelled through the
   separate grant status; a principal without a token and a join code are
   informational rows. `cswarm members` reads the same resource, prints the
   new section and includes `pending` in JSON.
3. Connected remains the server's `agent_tokens.first_used_at`: the first
   authenticated agent call of any kind clears the classic row. Join codes
   clear when exhausted, revoked, or expired. This lane adds no setup-error
   reporting surface; that is option B.

## Controls

- `tests/p1-server/pending-access.test.ts` is in the `test:p1-server` glob. It
  creates two workspaces and asserts both positive and cross-workspace empty
  reads. It checks the exact ten-column result and function output names for
  hash, secret, locator, and token leakage, and checks role grants. Mutation
  controls mark a visible token first used, exhaust a visible join credential,
  and revoke a visible no-token principal; all three must disappear. It also
  seeds expired and revoked join credentials and asserts they stay hidden. The
  local-stack test was written for the lead's isolated database run and was
  not executed here, so its result is not established.
- `tests/p1-cli/pending-access.test.ts` exercises parsing, age, roster text,
  clearing on an empty server snapshot, refusal of a malformed kind, explicit
  JSON projection despite an extra server field, and the exact edge request.
- `tests/p1-cli/citation-drift.test.ts` updates the seven pinned `src/cli.ts`
  line references moved by this change; its one focused test passes.
- `site/src/components/app/access-lifecycle.observer.test.ts` exercises the
  shared row model: both kinds, age, capacity, retention of classic token
  cancellation, and clearing when the polled snapshot removes the rows.

## Local gates

- `npm run build`: exit 0.
- `npm run check:tests`: exit 0.
- `npm run check:edge`: exit 0 (all six checked entry points).
- `npm run build:command-core && git diff --exit-code -- supabase/functions/_shared/protocol.js`: exit 0; protocol bundle unchanged.
- `bash scripts/build-release.sh`: exit 0, shipped bundle executed and reported version `0.1.76`.
- `npm --prefix site run build`: exit 0, 12 pages built.
- Focused CLI/site/citation test invocation: exit 0, 27 passed, 0 failed.
- Dispatch baseline unchanged; there are no changed rows to regenerate.
- `env -u FORCE_COLOR npm test`: exit 1, 962 tests, 960 passed, 2 failed:
  the real `ps` probe and the real resume CLI. This sandbox denies process
  inspection/spawn with `EPERM`.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1, 571 tests, 561 passed,
  9 failed, 1 skipped. This worktree lacks `site/.env`; built-provider controls
  fail. Browser geometry, screenshot evidence, and the 30-second result writer
  also fail in this sandbox. The focused pending-access tests pass.
- `env -u FORCE_COLOR npm run test:p1-cli`: first attempt timed out at 180
  seconds. The final process-group-bounded run exited 1 with 925 tests,
  907 passed and 18 failed. Failing tests cover process inspection/spawn,
  hook locks, receipt CLI subprocesses, a feed body limit, and the real resume
  CLI. None names the new pending resource. The citation-drift failure caused
  by the new `src/cli.ts` lines was fixed; its focused test passes.
- `git diff --cached --check`: exit 0 before commit. The final
  `origin/main...HEAD` range check is reported after the commit.

## Required box release after review and merge

Only HezLead directs and Anvil executes `deploy/RELEASE-TO-BOX.md`. The reviewed
full SHA must first land on `main`. This is an `edge stack` release because it
adds a migration and changes `read`; the site and CLI also need separate
release steps. Supply exact-SHA gate evidence, the migration catalog proof,
the function privilege/output-column proof, and an authenticated functional
probe. Take and verify the required fresh complete database backup. Apply
`20260924000001_pending_access.sql` from the immutable stack release and
verify its ledger/catalog state before recreating the edge runtime from the
same reviewed SHA on `commonswarm-net`. Compare stack runtime files: a
migration-only change does not switch `stack/current`. Release the site after
the edge is verified; build and publish the CLI bundle separately. Verify a
human and an agent in workspace A see A's pending rows and get an empty result
for workspace B, then verify first use, exhaustion, revocation, and expiry.

## Initial lane state (superseded below)

At the initial handoff, the migration and new read resource had not been
applied to a local isolated stack or to production. The Fold 1 post-apply
update below records the later local reset and server result. Hosted behavior,
one-minute poll timing, and a box release were not measured at initial handoff.

## Fold 1 — 2026-09-24

Both review arms failed the principal-wide dead-token filter. This fold applies
their rulings without contacting a production host. The source-mode server probe
uses the lead's loopback stack inside a rolled-back transaction; the normal
server test still checks the database function actually installed by the lead.

| Ruling | Change | Test and mutation result |
|---|---|---|
| J1 | The SQL rejects a principal after **any** first use, but otherwise accepts a no-token principal or one with a live unused token. The LATERAL takes the newest live unused token for age and expiry. The app keeps its original per-token pending rows and Cancel action, then adds server-only no-token and join rows. A dead sibling does not hide a live replacement. A principal that has ever connected stays off the pending list. | Server source-mode baseline 1/1. Revoked sibling and expired sibling each remain visible; used sibling and dead-only principals do not. Newest-token age assertion kills ascending order. Site observer 24/24; its existing-token row retains the original owner/expiry line and Cancel identity while a join row remains. Client mutations of the classic-token loop and server-only rows both exited 1. |
| J2 | The server fixture covers revoked and expired siblings, several tokens with one used, revoked-only, expired-only, no-token, and live/partly used/revoked/expired/exhausted join credentials. Catalog assertion now compares all ten names and their count exactly. | Rolled-back SQL mutation run: baseline exit 0; all 15 filter/order mutants exited 1 on assertions. See the local scratch probe `scratchpad/item-j-fold1/mutate-sql.py`; it is ignored, not release input. |
| J3 | Every seeded database row is inserted inside one transaction deliberately rolled back; the test asserts zero remaining workspaces and join credentials. Workspace names and mint ids include random UUIDs. Auth test users are deleted in `finally`. | Source-mode baseline passed its zero-leftovers assertion. A safe cleanup mutant let the fixture savepoint commit inside a protective outer transaction: the zero-leftovers assertion exited 1, then the outer transaction rolled back. The installed old function's negative control failed at the expected visible-row count; its fixture also rolled back. |
| J4 | Added `deploy/release-proofs/item-j/20260924000001-catalog.sql` and `20260924000001-functional.sql` in the H0 proof shape, with a README giving the section 5 transfer location. The catalog proof checks owner, security definer, stable volatility, search path, exact ten output names, and execute grants. It ends with its own `catalog_ok` `\gset`. | Both proof bodies ran read-only on loopback: catalog returned one `t`; functional check passed. The CLI test checks both files exist and the catalog ends in `\gset`; removing the terminator exited 1. Removing either proof file also fails its required read. No remote database was used. |
| J5 | `cswarm members` treats a pending-read failure as `null` and prints its member roster plus `Invited, not connected: could not load`. The app opens the workspace, retains classic token rows, and exposes the same note in its pending section; a zero-agent workspace still shows the header door. | CLI focused 4/4: network, 404, and 500 reads return `null`, and the roster renders members plus the note. Site focused 24/24: the same read failures return an empty pending result with a failure flag; source wiring pins the note and header door. Client mutations of both fallbacks, the zero-agent door, and the CLI note each exited 1. |
| J6 | No index added. | The CLI test rejects `CREATE INDEX` in this migration; adding one in a temporary mutation exited 1. Opus measured the current query at 2.4 ms raw and 3.6–5.6 ms as a function with about 3.8k principals and 3.1k join credentials. Global history can increase the principal and registrar scans; revisit indexing when measured latency warrants it. |
| J7 | Classic entries require a live owner membership. | Server fixture has an owner whose membership was revoked and asserts the principal is hidden. Removing the owner gate exited 1 in the SQL mutation run. |

The 15 SQL mutants, each exit 1 after a passing baseline in the same invocation:
`reader-membership`, `principal-workspace`, `principal-revoked`,
`registrar-hidden`, `used-token`, `revoked-token`, `expired-token`,
`no-token`, `dead-only`, `owner-member`, `newest-live-token`,
`join-revoked`, `join-workspace`, `join-expired`, and `join-cap`. The four
mutants with terse assertion output (`reader-membership`, `principal-revoked`,
`newest-live-token`, `join-cap`) were separately checked to be assertion
failures, not SQL errors. The six client mutants and the two proof/index mutants
also exited 1 after their passing controls. The cleanup mutant exited 1 on an
assertion after its baseline exited 0; its protective outer transaction rolled
back. All probe SQL transactions rolled back, and the scratch scripts are ignored.

Release order: the migration and `read` edge must reach the box and pass their
proofs **before** publishing the CLI to npm or releasing the site. Only HezLead
directs and Anvil executes that release from a reviewed SHA landed on `main`.
The migration is additive; a merge alone does not apply it.

### Fold 1 gates

Every gate ran under a process-group timeout. Logs are local ignored scratch data;
only exit codes and counts are release evidence. The unchanged sandbox failures
do not prove those suites pass on an unrestricted host.

| Gate | Exit and count |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 1; 962 tests, 960 passed, 2 failed. The real `ps` and resume subprocess fail with sandbox `EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1; 927 tests, 909 passed, 18 failed. Failures are the pre-existing sandbox process, lock, receipt subprocess, feed, and whoami probes; the pending test and citation test pass in focused runs. |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0; six entry points checked |
| `bash scripts/build-release.sh` | 0; bundle execute check passed |
| `npm --prefix site run build` | 0; 12 pages built |
| `env -u FORCE_COLOR npm --prefix site test` | 1; 572 tests, 568 passed, 3 failed, 1 skipped. Browser geometry, screenshot writer, and dynamic-viewport tests fail in this sandbox. |
| Focused server source mode | 0; 1/1 passed on loopback, in a rolled-back transaction |
| Focused site pending/header observers | 0; 37/37 passed |
| Focused CLI pending and citation | 0; 5/5 and 1/1 passed |
| `git diff --check` before commit | 0 |

`git diff --check origin/main...HEAD`: exit 0 after the Fold 1 commits.
Both new commits passed the local identity and agent-trailer guards (4 address
fields and 2/2 commits, respectively).

### Fold 1 post-apply update

After Fold 1, the lead ran `db:reset` on the local stack. The checker measured
the installed function body against the lane migration and ran the normal
server test: 1/1 passed. This supersedes the earlier “not installed” note.
It does not establish that the Fold 2 migration body is installed. No
production, browser timing, or release behavior was measured.

## Fold 2 — 2026-09-24

The Strategist ruled all five Opus findings in scope before the box release.
This fold changes the lane migration; the lead must run `db:reset` and the
server suite again after this commit. All local SQL source-mode probes ran
against loopback and rolled back their fixture and function changes.

| Ruling | Change | Test or proof and mutation result |
|---|---|---|
| F1 | The join-code branch now requires a live issuer membership. | The server fixture adds a live, unexpired, unfilled code whose issuer membership is revoked. Baseline source-mode server test: 1/1. Removing only the new predicate makes seven rows instead of six; test exit 1 on the row-count assertion. |
| F2 | The section 5 catalog proof pins `md5(pg_proc.prosrc)` to the migration body, alongside its shape and grants. The functional proof discovers a live member with a real pending row, requires at least one row for that member, and then requires exactly zero rows without member identity. The release proof README requires that row to be seeded through the normal product path before the release window. | The server test executes both SQL proofs against its seeded fixture. Baseline: 1/1. Changing the issuer display literal only, preserving shape, makes catalog `catalog_ok=false`; test exit 1 on the catalog assertion. Replacing the function's membership guard with `IF false` makes the functional proof raise `pending access returned rows without a member identity`; test exit 1. Changing the guard to `IF true` makes the positive proof raise `no seeded pending row visible to a live member`; test exit 1. The CLI test recomputes the body digest from the migration and checks the catalog constant, so stale proof text also fails. |
| F3 | Added source-enumerating TypeScript AST checks for the `runMembers` read and every `pendingAgentAccess` call in the app script. | CLI focused test: 6/6; replacing `readPendingAccessOptional` with the throwing `readPendingAccess` in `runMembers` changes the discovered call and fails its assertion. Site observer: 25/25; it discovers four calls and verifies each direct `loadPendingAccess` wrapper. For each of the four, an in-memory revert to the direct throwing call makes the observer throw. |
| F4 | The roster dialog's Pending access section now uses its existing grid, gap, padding and border at every width; the old desktop `display: none` rule and now-redundant narrow override are gone. | The source observer asserts desktop-capable grid display. A rendered geometry test checks the section at 600px and 1200px, including the `[hidden]` case. The existing geometry test and the new test both fail here because sandboxed Chrome aborts with `SIGABRT`, before measuring CSS. The CSS revert is rejected by the source observer; rendered geometry remains for the lead's unrestricted run. |
| F5 | Removed the stale Fold 1 “not installed” note and recorded the lead's earlier local `db:reset` plus passing normal server test. This table lists every Fold 2 code, proof, and test change. | The CLI evidence test passes 7/7. In a temporary file mutation, restoring the `Fold 1 not established` heading makes that test fail on the missing post-apply reset record (exit 1); restoring the file returns it to 7/7. |

### Fold 2 gates

All commands ran with a process-group timeout. Exit 1 in the full suites is
reported rather than hidden; focused tests for this fold passed. Ignored
scratch logs contain the detailed output and are not release inputs.

| Gate | Exit and count |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 1; 962 tests, 960 passed, 2 failed. The real `ps` and resume subprocess fail under sandbox process restrictions. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1; final run: 929 tests, 911 passed, 18 failed. Failures are the sandbox process, hook lock, receipt subprocess, feed limit, and live whoami probes; all 7 pending-access tests passed in this full run and the focused run. An earlier run before the final evidence assertion had 928 tests, 909 passed, 19 failed. |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0; six entry points checked |
| `bash scripts/build-release.sh` | 0; shipped bundle execute check passed, version 0.1.76 |
| `npm --prefix site run build` | 0; 12 pages built |
| `env -u FORCE_COLOR npm --prefix site test` | 1; final run: 574 tests, 570 passed, 3 failed, 1 skipped. The two geometry cases and screenshot/result writer could not run under sandboxed Chrome. An earlier run had 569 passed and 4 failed; its dynamic-viewport case also failed. |
| Focused server source mode | 0; 1/1, including both release proof SQL files against the seeded fixture |
| Focused CLI pending | 0; 7/7 |
| Focused site pending observer | 0; 25/25 |

`git diff --check origin/main...HEAD`: exit 0 after the Fold 2 commits.
The local identity guard accepted all 14 address fields in seven lane commits;
the trailer guard checked 7/7 commits. The worktree was clean after commit.

### Fold 2 not established

Correction (lead, after fold 2): the lead ran `npm run db:reset` at 90467bbf, which installed
the Fold 2 function on the local stack, and the normal server suite passed 243/243; the site
suite, including the rendered 600px/1200px width test, passed outside the sandbox (573, 1
skipped). The Opus arm ran both box proofs read-only on the local database and made each
fail for its stated reason. Still not established: the proofs under the box's own database
role, hosted behavior, and production query plans. Follow-up (Opus round 3, not done): the
server test runs the catalog-digest check before the behaviour checks, so a future mutation
run cannot tell which behaviour check caught a changed body; move it to the end of the test.
