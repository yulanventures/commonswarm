# Frozen bundle status (lane/c1-frozen-work)

Branch `lane/c1-frozen-work`, based on origin/main `a5cb8251`. HezLead owns
review and integration. Committed HEAD is `d965371b`: C1-1 TODO repairs are in `1c5d4dbc`, the
generator/run orders in `edf4a3bf`, C1-4 checker/ruling repairs in `69fa19f7`,
the first W4 Caddy production-defect repair in `03c3c9d4`, C1-6 in `6ca8f36e`,
and C1-7 in `d965371b`. C1-8 below is an uncommitted patch on that exact base. This worker does not
commit or push. No release or production execution is claimed.

## Done

| Item | Commit | Tests |
| --- | --- | --- |
| W6 binds an EARLIER W2b: inputs `w2b_release_sha` + `w2b_window_id` (W6 only); ai-w2b-proof-check reads the bound release; new ai-w6-issuer-live re-verifies the credential live (LOGIN with password, file 0440 root:986, TLS login with the installed credential, five forward catalogs true), called from ai-w6-activation-checks | 9570c67b | plan.test (inputs, proof-check at another release), w123 (issuer-live positive + 8 refusals), w6-ready, plan-sandbox inputs, W6 rehearsal inputs |
| W3 same-version retry: ai-release-aside (shared; parent root 0700, same filesystem, one rename, `oauth-aside.json`), ai-w3-rollback rewritten (paths from INPUTS, explicit-fail every step, `ln -sfT`, aside after the baseline is live, `W3-rollback.txt`), ai-w3-preflight refuses a present tree with the exact recovery and records other releases' trees in `oauth-releases-inventory.json`, ai-w3-apply `ln -sfT`, ai-close recovered W3 requires baseline current/image and no tree at this release | 9570c67b | w123 (rollback positive, idempotent rerun, nothing-to-move, 7 refusals x 2 errexit modes, stale-tree evidence, preflight refusal text), plan.test (recovered W3 close: 1 positive + 2 tolerated residues + 4 refusals) |
| Rulings folded as plan text (section "Execution rulings") | efd84d82 | prose only |
| W4 same-version retry: ai-w4-rollback (paths from INPUTS, `ln -sfT`, ai-release-aside with `edge` after current is on the baseline), ai-w4-preflight refusal with the exact recovery, ai-w4-apply `ln -sfT`, ai-close recovered W4 requires baseline edge current, baseline Caddy bytes, no drop-in, no tree | 9e32e3b6; execution gap closed by 1c5d4dbc, with C1-4 follow-up | w45 (leftover temporary link replaced, preflight refusal text; now full rollback + real edge aside, normal and modelled ignored-errexit), plan.test (recovered W4 close: 2 positives + 5 refusals; rollback order) |

## Test runs at 9e32e3b6 (mini, sandbox-exec no-real-chrome)

- The required test command without the gate: 293 tests, 293 pass, 0 fail.
- `RUN_PG_REHEARSAL=1 tests/c1-w2-rehearsal.test.ts`: 20 pass, 0 fail.
- Static sandbox tests (`extracted completely|names a GUI launcher`): 2 pass.
- `npx tsc -p tsconfig.tests.json --noEmit`: the 7 known errors only.
- The lead still runs the dynamic third test of `tests/admin-release-plan-sandbox.test.ts`
  (its W6 inputs now carry `w2b_release_sha`).

## Retry-precondition audit (W2b-W7) and cross-window bindings at the frozen release F

"Retry" = the same window run again at the same release with a new window_id.
Per-window names (PROOF_DIR, SECRET_STAGE, BOX_ARCHIVE_PATH, PREP_DIR, C1_PROOF_DIR,
`/tmp/admin-c1-*-<window_id>`, `*-attempted.txt` markers) are fresh for every
window_id, so they never block a retry and are not listed again.

| Window | What a failed attempt leaves | Same-version retry today | Status / fix |
| --- | --- | --- | --- |
| W2b | Issuer role LOGIN/password and credential file if the issuer step got far | ai-w2-issuer-rollback restores NOLOGIN/no password/no file; recovered close checks all three; ai-w2b-preflight requires that state | OK (existing). W2b cannot run at F at all: yYGHEd (a5cb8251) gave the issuer LOGIN; W6 binds it cross-release (fixed, 9570c67b) |
| W2b | Retained `/tmp/admin-issuance-a5cb8251...-yYGHEd.tar` | ai-w2b-proof-check needs it to revalidate the W2b receipts | RISK, not a plan change: `/tmp` must survive until W6 (a reboot or tmp reaper refuses W6). HezLead to verify before W6 |
| W3 | `oauth/releases/<sha>` tree (preflight copy) | Refused (WWcpPi) | FIXED 9570c67b: rollback moves it to `oauth/failed-attempts/<sha>-W3-<window_id>`; recovered close requires it absent; preflight refuses with the exact recovery |
| W3 | Stale tree of an EARLIER release (a5cb8251 from IkdTa6) | Not at F's path | FIXED 9570c67b: ignored with evidence (`oauth-releases-inventory.json`); retention is a separate assignment |
| W3 | `current.admin-issuance` temporary link (crash between ln and mv) | `ln -s` would create a link INSIDE the target directory | FIXED 9570c67b (W3) and 9e32e3b6 (W4): `ln -sfT` |
| W3 | compose.env, service.env, running container, `current` | Rollback restores from the window's SECRET_STAGE copies; recovered close now checks current + image | FIXED 9570c67b (close checks) |
| W3 | Image tag `commonswarm-oauth:release-<sha>` | Reused if cached; label checked | OK (deterministic) |
| W4 | `edge/releases/<sha>` tree | Rollback moves it aside after restoring the baseline | FIXED 9e32e3b6; TODO-1 DONE in 1c5d4dbc, with C1-4 follow-up: rollback executed end to end, including real edge aside and explicit failures |
| W4 | `edge/current.admin-issuance` link | `ln -s` hazard as W3 | FIXED 9e32e3b6 |
| W4 | Live Caddy files | Rollback restores from SECRET_STAGE; ai-box-preflight byte-checks the baseline hashes at the next open | OK (existing); recovered-close check added 9e32e3b6 |
| W4 | Recycle drop-in | Rollback removes it; ai-recycle-install refuses a present one | OK (existing); recovered-close check added 9e32e3b6 |
| W4 | Hook binary and `recycle.json` | Overwritten by the retry's ai-recycle-install (O_TRUNC, write_text); nothing reads them while the drop-in is absent | OK (deterministic overwrite) |
| W4 | DB: legacy fence, generation +1, invalidated_at | apply_legacy_admin_fence returns early when already closed; apply closes before measuring | OK (idempotent) |
| W4 | Recycle timer stopped | ai-timer-guard re-arms on every exit; ai-close refuses an inactive timer | OK (existing) |
| W5 | Site release dir, Mac W5 root, PREP_DIR | Site releases are timestamped; W5 root and PREP_DIR are per window_id; the site plan owns its rollback | OK |
| W6 | Smoke pointer `/Users/yulanbot/work/dcr-rt/c1-smoke.pointer` (fixed path) | ai-w6-pointer refuses a present pointer with the exact cleanup recovery; recovered close requires uploaded C1-cleanup.txt only after secret-stage.path exists in the Mac C1_PROOF_DIR; C1-close-state.json binds that measurement | TODO-2 DONE in 1c5d4dbc, with C1-4 follow-up |
| W6 | C1 verification row at version v | Identical row accepted | OK |
| W6 | Owner approval at v, withdrawn by the failed W6 | Reusing v refuses with the next version; a new reviewed version supersedes the active row only when this owner's approval is withdrawn and no owner has a live approval at that version. Missing approval still refuses a second active version | TODO-3 DONE in 1c5d4dbc, with C1-4 follow-up; reducer still refuses `client_approval_withdrawn` at v |
| W6 | Generation +1 after rollback/emergency close | The edge receipt is stale; ai-edge-refresh first (existing rule) | OK |
| W6 | Recycle timer held | Apply/rollback/finish re-arm it; ai-close refuses inactive | OK |
| W7 | Proof files only (read-only proof) | Fresh window_id | OK |

| Binding at F | Rule | Status |
| --- | --- | --- |
| W2b -> W2 | `w2_release_sha` + `w2_window_id` (cross-release) | OK (existing) |
| W6 -> W2b | `w2b_release_sha` + `w2b_window_id` (cross-release) + live re-verification | FIXED 9570c67b |
| W6 -> W5 | W5 closed at F (inputs release_sha); BROWSER-READY newer than that close | OK: W5 runs at F |
| W6 -> W4 | `approved_edge_release_sha = F`; recycle.json release F and W4 archive | OK: W4 runs at F |
| W6 -> W3 | oauth current and image label = F | OK: W3 runs at F |
| W7 -> W6 | `w6_window_id`, same release F; second checker receipt (ruling 6) | OK (existing); receipt is an input |
| Consent receipts | pre-W1 and post-W5 receipts carry release_sha F | Inputs: a NEW pre-W1 consent receipt at F is required before W3 |
| GATES.json | checker receipt for F (and the W7 second receipt) | Input |
| Migrations | W6 compares ledger checksums (recorded at W2 5f64fab4 and W2b) with F's 12 migration files | Frozen-release constraint: F must not change any of those 12 files; ai-w6-activation-checks STOPs otherwise |

## C1-1 completed TODOs (committed in 1c5d4dbc; C1-4 follow-up prepared for HezLead)

- **TODO-3 DONE — W6 C1 version retry.** `ai-w6-client-verification` locks the
  active verification and all approvals at its version; any live owner approval refuses superseding. A withdrawn approval at the
  requested version refuses with an exact FAIL line naming the next version.
  At a different version it supersedes only the three guard-permitted columns
  (`active`, `withdrawn_at`, `withdrawal_reason='c1-retry-superseded'`), then
  inserts the reviewed version in the same transaction. The release role lacks
  approval SELECT: the DO block reads that approval as the session principal,
  restoring the release role before writes; no grants or migrations changed.
  Test: `c1 W6 retry: migrated schema supersedes a withdrawn owner version;
  same-version, live and missing approvals refuse` in
  `tests/c1-w2-rehearsal.test.ts`: real migrated PostgreSQL 17, seed-only
  replication mode, another owner's withdrawn approval, unchanged live/missing
  refusals, idempotent reruns, immutable approval history, and baseline controls.
  The existing `second-active-version` W6 rehearsal refusal also remains.
- **TODO-2 DONE — W6 pointer.** The exact stale-pointer recovery now names
  `ai-w6-secret-close` and the earlier window's `C1_PROOF_DIR`. A recovered W6
  close after Mac `secret-stage.path` requires uploaded `C1-cleanup.txt`. A bound
  `C1-close-state.json` distinguishes it from the box session stage. Client-check
  before start needs no runner cleanup; nonregular files and symlinks, including dangling ones, refuse.
  Tests in `tests/admin-release-plan.test.ts`: `admin release plan: D8 pointer
  emits only paths, consent choices and UTC expiry; secret-shaped name refuses`
  now checks retained regular and dangling-symlink pointers and the exact FAIL
  text; `admin release plan: W6 close requires cleanup only after Mac start, rejects symlinks, and removes its private window` runs the full
  close for missing cleanup after start, recovered started with cleanup, and
  recovered checked-before-start without cleanup, alongside the forward-close
  controls and regular/dangling symlink refusals.
- **TODO-1 DONE — W4 rollback execution.** Every fallible rollback command now
  has an explicit `|| { FAIL }`; `ln -sfT` and all block headers are retained.
  Tests in `tests/admin-release-live-failclosed-w45.test.ts`:
  `same-version retry / w4-rollback-moves-tree-aside: baseline compose and Caddy
  restored, timer re-armed, evidence kept, rerun idempotent` runs full rollback
  and the real edge aside in normal and modelled ignored-errexit modes, plus
  no-tree recovery. `same-version retry / w4-rollback-refusals: each failure
  stops before the aside and completion, also with ignored errexit` covers
  individual command failures, wrong image, live failed tree, unsafe aside
  owner and collision in both modes, with a baseline defect control.

Residual gap: the guard's `fence_admin_family(...,'suspended')` on already-revoked
bindings is **not exercised** by the retry rehearsal. It seeds approval history,
not a revoked family binding; no claim of that fence coverage is made.

Existing fixture updates: `admin release plan: every timer-owning body recovers
after stop failure or its first subsequent failure` now locates a timer-guard
call with an explicit failure clause. `W6 client verification: canonical digest
equals canonicalAdminJson; the release-role insert carries the reviewed
constants` now supplies the owner UUID required for the approval lookup.

## C1-4 verification (patch committed in 69fa19f7)

At committed HEAD `edf4a3bf`, C1-3 reported 162/164 passing, exit 1. The two
failures loaded HEAD as an old-behavior control after HEAD contained the fixes.
C1-4 pins both to exact pre-fix commit `50759707` and fails clearly if absent.
The independent box-dispatch allowlist test fails on `1c5d4dbc` for missing
`ai-release-aside`; C1-4 adds that helper and `ai-w6-issuer-live` to the dispatcher.
All eight Lead rulings now have one run order, with no alternatives.

Final C1-4 prepared-patch gate on 2026-10-05:
`C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh`
— **167 tests, 167 pass, 0 fail/cancelled/skipped/todo, exit 0**
(234420.645417 ms). The first C1-4 gate returned 164/167 passing, exit 1:
W5's added verified reader changed the reader inventory, and its timestamp
writer duplicated a rehearsal extraction anchor. The reader inventory now
includes W5 recovery; the W5 timestamp/timer names preserve the existing anchors.
The focused W6 PostgreSQL rehearsal then passed, followed by the final gate.
Full logs: `scratchpad/c1-4-gate.log` and `scratchpad/c1-4-gate-final.log`.
That historical gate measured the prepared C1-4 patch, subsequently committed
in `69fa19f7`; it did not measure CI or production.
No full suite, build, Docker or browser was run; no commit or push was made.

## C1-5 W4 Caddy import form (committed in 03c3c9d4)

Found during staging preparation on 2026-10-05: the reviewed, scrubbed production
`/etc/caddy/Caddyfile` uses `import sites/*.caddy`. The copy at
`/Users/yulanbot/work/c1-frozen-resume/staging/prod-files/Caddyfile` is the
task's byte-identical production input, with no secrets. Its 614 bytes are now
copied into the W4 test fixture. The old `ai-w4-caddy-candidate` required only
the absolute form and stopped with `FAIL Caddy import form; STOP`.

The prepared fix enumerates active import lines and accepts exactly one line,
either `import sites/*.caddy` or `import /etc/caddy/sites/*.caddy`. Zero,
duplicate, mixed, and other-target imports stop with one exact FAIL line that
lists the accepted forms and the lines found, without a traceback. Relative
form stays relative; absolute form points at the resolved candidate directory.
Caddy resolves a relative import against the containing config file, so
`caddy validate --config "$SECRET_STAGE/Caddyfile"` reads
`$SECRET_STAGE/sites/*.caddy`, even with the live config directory as cwd.
The live Caddyfile is never rewritten. Shifted run-order quote references were
refreshed; the generator still extracts all 18 tasks.

Root-Caddyfile audit (all five marked blocks that reference it):

| Block | Production relative-form result |
| --- | --- |
| ai-box-preflight | SHA-256 of the live root Caddyfile and both site files; no import parsing or normalization. Accepts the recorded production bytes. |
| ai-w4-caddy-candidate | The import-form repair above; candidate root config only. |
| ai-w4-apply | Compares both live site files to their baseline copies and hashes the untouched root Caddyfile against `baseline_caddyfile_sha256`. Installs only site files, then validates `/etc/caddy/Caddyfile`; the relative import resolves to the live sites at that location. |
| ai-w4-rollback | Restores only the baseline site files, leaving the root Caddyfile untouched, then validates `/etc/caddy/Caddyfile`. It has no separate root-Caddyfile hash check; recovered close owns that comparison. |
| ai-close recovered W4 | Hashes all three baseline Caddy files, including the root Caddyfile, and checks the baseline edge, absent drop-in and absent failed release tree. No import parsing or normalization. Its fixture now uses `import sites/*.caddy`. |

Verification: the new tests first failed on the unmodified plan for the intended
`FAIL Caddy import form` defect. After the import repair, the exact-refusal
matrix passed (zero, duplicate-relative, mixed-relative/absolute, other target,
and accepted-plus-other target). The standalone generator file passed 7/7;
`bash -n` passed all 87 complete plan blocks; copied production fixture byte
equality and `git diff --check` passed.

**The C1-5 gate was not green.**
`C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh`
returned **169 tests, 168 pass, 1 fail, 0 cancelled/skipped/todo, exit 1**
(212560.580917 ms). Log: `scratchpad/c1-5-gate.log`; exit receipt:
`scratchpad/c1-5-gate.exit`.

The only failure is the new real-Caddy candidate validation test, using the
official Caddy v2.11.7 Mac arm64 binary (publisher SHA-512 checked), with the
fixture's live sites directory emptied after copying and cwd set to the live
config directory. Import handling passes, then Caddy reports
`File to import not found: admin_resource_active`: the generated
`10-commonswarm-api.caddy` imports that snippet before the later
`20-commonswarm-mcp.caddy` defines it. This is a second route-generation defect,
outside the assigned import-form repair. The relative case stops there, so the
real-Caddy absolute case and subsequent candidate-corruption control have not
completed. No successful real candidate validation is claimed.

C1-5 stopped at that scope boundary. HezLead then assigned the snippet-order
repair in MAKER-C1-6.md. The original downloaded binary is retained at `scratchpad/c1-5-tools/caddy`; tests accept
`C1_CADDY_BINARY` or `caddy` on PATH, with that local path as fallback.
No full suite, build, Docker, browser, commit, push or production operation ran.
HezLead owns the cross-family check.

## C1-6 checker round 2 and second Caddy production defect (prepared at 03c3c9d4)

The latest Grok and Cursor reviews at
`/Users/yulanbot/work/c1-verify/review/runs/20261005T232843Z-3a3ba5`
both failed: W5 could close a GO failure without a deploy, and W6 could
execute its audit twice. C1-6 repairs both in the run orders and their owning
boundaries. Every W5 recovered-close step carries its companion failure or
closure condition; rollback-only orders carry the same failure conditions.
`ai-close` requires manifest-bound `GO.txt` (selected and baseline SHA plus
HOLDS_RESOLVED) and `deploy-status.txt` with `deploy_exit`, written by site2-04.
Absent/invalid deploy evidence reports an exact FAIL line saying the incident
stays open. A GO failure retains its pin/window. The W5 test executes the
companion's actual public-control automatic rollback, failed-before-switch
reconciliation and box pin-close bodies on temporary files, then the C1 close.
SSH, host identity and GNU file flags are adapted locally; browser/public
rollback acceptance receipts remain fixtures. No production/browser execution
is claimed.

The W6 forward audit entry is a non-executable manual dispatch record.
Generator version 4 attaches the audit block once to the fence driver's
`dispatched_blocks`, with `dispatched_by` naming that driver. The generated
W6 task contains its exact audit block bytes once and has no second executable
audit step. The parser also refuses unknown keys (including quote, site-plan
and not-run keys), unknown section lines and legacy tables; section prose is
outside the machine-read section.

The second W4 production defect was found by C1-5's real-Caddy validation,
after the first defect was found using the staged production Caddyfile:

- First: live `import sites/*.caddy` was refused by an absolute-only check.
  Committed repair `03c3c9d4` preserves relative imports and redirects only the
  supported absolute form in the task-owned candidate.
- Second: lexical `10-commonswarm-api.caddy` imported `admin_resource_active`
  before `20-commonswarm-mcp.caddy` defined it. C1-6 defines both shared admin
  snippets at the top of the API candidate, before either site uses them.
  The sources remain inside `RELEASE.md` (`ai-w4-caddy-candidate`); no extra
  installed file is added. W4 still installs/restores the same two files, so
  rollback and the three baseline byte checks retain their exact file set.

Both import forms passed real Caddy v2.11.4 (production version) validation
and adaptation with the live sites directory empty and cwd at the live config
directory. Candidate corruption still fails. The official Mac arm64 archive's
SHA-512 matches the publisher checksum; the binary is retained at
`scratchpad/c1-6-tools/caddy`. The same tests also passed v2.11.7.

Supersede now locks the approval table in SHARE ROW EXCLUSIVE mode as the
existing session principal, before checking approvals, until commit. This
briefly blocks approval writes for all clients (a broader lock than this
client/version), closes the insertion race and adds no grants. A two-connection
PostgreSQL 17 rehearsal holds the generated supersede transaction open: a
fresh-owner INSERT hits lock_timeout until commit, then succeeds; removing
only the new lock makes that same concurrent INSERT succeed immediately.
Seed INSERTs bypass evidence triggers only; the real schema/locking remain.
The W5 pre-open ruling now names the full ai-live-controls execution by
ai-w5-preflight at `$PREP_DIR/w5-live-before` with the pre-W1 consent receipt.

Regression controls at committed base `03c3c9d4` failed for the intended causes:
W5 closed the no-deploy fixture, Caddy could not import admin_resource_active,
W6 emitted an executable audit entry, and the generator accepted a legacy
section table. The edited files were restored byte-for-byte after these checks.
Logs: `scratchpad/c1-6-prefix-{w5,caddy,audit,parser}.log`.
Focused repaired tests passed: generator 7/7; W5 close 1/1; W6 retry/race 1/1;
real-Caddy/import-refusal matrix 2/2 on each tested Caddy version.

Required C1-6 final gate:
`C1_CADDY_BINARY=/private/tmp/cs-c1-frozen/scratchpad/c1-6-tools/caddy C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh`
— **169 tests, 169 pass, 0 fail/cancelled/skipped/todo, exit 0**
(197166.405417 ms). Log: `scratchpad/c1-6-gate-final.log`; exit receipt:
`scratchpad/c1-6-gate-final.exit`. That run measured the then-uncommitted C1-6 patch,
not CI or production. The first C1-6 gate was 168/169, exit 1: the new generator
test expected three selected companion failure-table rows to be adjacent.
It now verifies each row verbatim against the companion; generator 7/7 and
then the full required gate passed. First log: `scratchpad/c1-6-gate.log`.
`bash -n` passed all 87 marked blocks; `git diff --check` passed.
No full suite, build, Docker, browser, commit, push or production operation ran.

## C1-7 supersede lock order (prepared at 6ca8f36e)

Grok round 3 at
`/Users/yulanbot/work/c1-verify/review/runs/20261006T000331Z-941888/grok/result.md`
found the cross-client cycle: C1-6 supersede held the approvals table and waited
for a binding owner's account, while that owner's approval for another client
held the account and waited to INSERT into approvals. PostgreSQL aborts one
transaction with `40P01`.

`ai-w6-client-verification` now prelocks `swarm.admin_accounts` with `FOR UPDATE
OF a`, ordered by `owner_user_id`, for every owner in `admin_grant_bindings`
matching the superseded client and verification version. There is no state
filter: `guard_verified_client` visits terminal bindings too. EXISTS selects
each account once even when an owner has several bindings. The active verified
row is locked first, so new conforming bindings cannot appear during that
selection. The account locks precede the approvals table lock. These extra
binding reads and account locks run after RESET ROLE as the existing session
principal; SET LOCAL ROLE commonswarm_admin_release is restored before the
verification UPDATE/INSERT. No grants or function privileges change. Same-version
and first-insert paths take neither the account prelocks nor the table lock.

Lock audit (row locks unless a table/unique/FK lock is named; reentrant locks
are retained through transaction end):

| Path | Locks in acquisition order |
| --- | --- |
| C1-6 supersede control | cutover singleton FOR UPDATE; active verification FOR UPDATE; approvals table SHARE ROW EXCLUSIVE; approvals FOR SHARE; trigger verification FOR SHARE (already owned); **binding owner account FOR UPDATE**; grant FOR UPDATE; binding FOR UPDATE; tombstone INSERT/unique conflict check |
| C1-7 supersede | cutover singleton FOR UPDATE; active verification FOR UPDATE; **all binding owner accounts FOR UPDATE in owner order**; approvals table SHARE ROW EXCLUSIVE; approvals FOR SHARE; restore release role; verification UPDATE (ROW EXCLUSIVE table lock, same row); for each binding in owner/grant order: verification FOR SHARE (same row), account FOR UPDATE (preowned), grant FOR UPDATE, binding FOR UPDATE; grant/binding UPDATE where live; tombstone INSERT ON CONFLICT DO NOTHING; verification INSERT/active-version unique-index check |
| Human approve | exact verification FOR SHARE via lock_admin_client_verification; owner swarm.users FOR UPDATE; account INSERT ON CONFLICT/unique check then account FOR UPDATE; owner's grants FOR UPDATE in grant order; exact approval FOR UPDATE (ROW SHARE table lock); rate bucket INSERT/UPDATE in sorted key order; account event INSERT; grant upserts and consumed-consent/account UPDATE; approval INSERT (ROW EXCLUSIVE table lock), evidence SELECT and FK KEY SHARE checks on prelocked account/verification plus the new event; command-result INSERT |
| Human withdraw approval | exact verification FOR SHARE; user FOR UPDATE; account INSERT/unique check and FOR UPDATE; owner's grants FOR UPDATE in grant order; exact approval FOR UPDATE; sorted rate buckets; event INSERT and grant/consent/account persistence; approval UPDATE (ROW EXCLUSIVE table lock); evidence SELECT; for each binding in grant order: verification FOR SHARE (preowned), account FOR UPDATE (preowned), grant FOR UPDATE (preowned), binding FOR UPDATE; grant/binding terminal writes and tombstone INSERT/unique conflict check; command-result INSERT |
| Human revoke delegation | user FOR UPDATE; account INSERT/unique check and FOR UPDATE; owner's grants FOR UPDATE in grant order; membership/workspace FOR SHARE for required current rights; sorted rate buckets; event INSERT; terminal grant upsert; family trigger: live binding UPDATE, guard's grant FOR SHARE (preowned), terminal-binding trigger's verification FOR SHARE, account/grant FOR UPDATE (preowned), binding FOR UPDATE; tombstone INSERT/unique conflict check; terminal audit INSERT with FK KEY SHARE on account/grant/binding; consumed-consent/account UPDATE; command-result INSERT |

Nested triggers examined: `guard_admin_binding` takes FOR SHARE on the already
locked grant. `binding_terminal_fence` and a newly inserted tombstone's
`tombstone_admin_family` re-enter `fence_admin_family` for the same binding,
verification, account and grant. `admin_grant_family_fence` updates that grant's
binding, then inserts the family tombstone and terminal audit. Each grant has
one binding (`admin_grant_bindings.admin_grant_id` is UNIQUE), so these calls
do not acquire a second client's verification or another owner's account.
Audit FK KEY SHARE checks revisit the account, grant and binding. Terminal
audit does not lock cutover; its FOR SHARE cutover lock applies only to issued
or rotated audit. The legacy grant guard reads cutover without a row lock.
No trigger here takes a user, membership/workspace, rate-bucket, command-result,
issuer-key or provider-resource advisory lock.

For approve/withdraw on the superseded verification, FOR SHARE waits before
the account stage. For another client with a binding owner, C1-7 serializes at
the account before either transaction can hold the other's later grant/binding
or approval-write lock. Other owners have disjoint grants/bindings; their
approval INSERT can wait on the table lock but cannot hold an account needed
by the supersede trigger. The table lock remains broader than this client and
version and lasts only until commit.

Human revoke's general order includes a late verification lock through a
terminal-binding trigger. On the superseded version, successful supersede
requires all approvals withdrawn; the real withdrawal trigger has already
terminalized the bindings and inserted tombstones. Revoke of an already
revoked/expired grant is idempotent. A suspended grant can become revoked,
but its already-terminal binding is excluded by the family trigger's
`state IN ('active','pending')` UPDATE and its tombstone INSERT is a conflict
no-op, so neither operation takes a new verification lock. A live approval
still refuses supersede before deactivation. For another client's revoke,
the verification lock concerns that other client; the shared owner account
serializes its later grant/binding/tombstone/audit work. This audit establishes
no further supersede inversion against the approve, withdraw or revoke paths
under their real durable-state invariants; it is not a global deadlock claim.

The existing migrated-schema W6 retry test now rehearses two contending
connections with both binding-owner accounts present, including the non-input
owner approving a different client. Only seed writes use replication mode;
both race transactions run with every trigger and FK check enabled. The
approve contender runs the command path's lock/evidence/INSERT SQL as
swarm_command, not the TypeScript handler or an HTTP request. A test-only
split of the generated DO prefix pauses supersede after the account prelock;
resumption re-enters the unmodified generated DO in the same transaction.
The plan contains no pause or test hook. Short observer connections read
pg_stat_activity/pg_blocking_pids to establish the two contenders' actual wait.

Focused rehearsal: **1 test, 1 pass, exit 0**. Final log:
`scratchpad/c1-7/retry-final.log`. Both binding-owner account probes hit lock_timeout.
The other-client approve then waited on the supersede account lock. Supersede
committed; approve completed its guarded INSERT and committed with no deadlock.
The exact C1-6 plan bytes at `6ca8f36e` first reproduced the inverse waits and
PostgreSQL `40P01` in the same invocation. The earlier insertion-race control
also remains: removing the table lock admits a fresh-owner INSERT; keeping it
blocks that INSERT until transaction end, after which the INSERT succeeds.
Release-role approval SELECT and account UPDATE privilege checks remain false.

Generator tests: **7 tests, 7 pass, exit 0** (`scratchpad/c1-7/generator.log`).
Required C1-7 gate:
`C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh`
— **169 tests, 169 pass, exit 0**. Log: `scratchpad/c1-7/gate-final.log`;
exit receipt: `scratchpad/c1-7/gate-final.exit`. Gate tail:

```text
ℹ tests 169
ℹ suites 0
ℹ pass 169
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 210418.858542
```

The first gate was 164/169, exit 1 (`scratchpad/c1-7/gate.log` and
`scratchpad/c1-7/gate.exit`): two added comment lines shifted the plan's quoted
line references, and the intentional deadlock victim could exit before the
control wrote ROLLBACK, producing EPIPE. The comment replacement now retains
the original line count; the control queues rollback before creating the
cycle and never writes to the victim afterward. The focused generator/retry
checks and then the exact required gate passed after these corrections.
`git diff --check` passed. No full suite, build, Docker, browser, commit, push
or production operation ran. HezLead owns the cross-family check.

## Handoff

HezLead owns the cross-family check and integration. C1-7 makes no commit,
push or production change. `VERIFY-HARNESS.md` stays outside this assignment.


## C1-8: W1/W2/W2b run orders and STG reservation (2026-10-05)

Uncommitted patch on `d965371b`, limited to RELEASE.md, this status file,
`scripts/c1-task-from-plan.mjs`, `tests/c1-task-from-plan.test.ts` and
`tests/admin-release-plan.test.ts`. No commit, push, production operation,
full suite, build, Docker or browser ran. HezLead owns independent review.

| Assigned item | Result | File:line |
| --- | --- | --- |
| A: W1 × forward/rollback/recovered-close | Done; common admission/open/session, backup gate and ordinary controls; additive recovery has no mutation block | RELEASE.md:166 |
| A: W2 × all three modes | Done; stage/preflight/fenced apply/reconcile/probes/issuer; recovery quotes STOP/retain/no retry/no automatic reserve and never dispatches apply or reserve | RELEASE.md:200 |
| A: W2b × all three modes | Done; the table's precondition is the first when in each mode; backup/preflight/issuer/forward catalogs; failure uses issuer rollback | RELEASE.md:246 |
| A: generator and complete accounting | Done; version 5 emits all 27 tasks, with byte-exact blocks and quoted lines; 87 definitions = 70 used (including nested dispatches) + 17 excluded helpers | scripts/c1-task-from-plan.mjs:9; tests/c1-task-from-plan.test.ts:81 |
| B1/B4: marker and production producer contract | Done as plan text; regular non-symlink root:root 0600, exactly 35 ASCII bytes, c1-staging-disposable-no-production, no newline; production producers redraw /^stg/i ids | RELEASE.md:40 |
| B2: box admission before other validation | Done; absent marker refuses all /^stg/i; valid marker requires uppercase STG plus three alphanumerics; malformed/unreadable/symlink marker always refuses with a fixed FAIL line | RELEASE.md:713 |
| B3: Mac admission via existing box measurement carrier | Done; no new INPUTS key; ordinary ids need no evidence; STG requires fresh, exact-input-bound marker measurement | RELEASE.md:686 |
| B5: zero-writer scan | Done; scans every RELEASE.md shell block and every regular file under scripts; negative writer probes cover redirections, install, cp, tee, touch, Python and Node writes, including a variable-bound path | tests/admin-release-plan.test.ts:2988 |
| B6: executable admission checks | Done; all requested production/staging/Mac cases, malformed mode/content/owner/symlink, plus newline, dangling symlink, bad binding/baselines and stale/future evidence | tests/admin-release-plan.test.ts:2904 |
| Physical staging marker and producer evidence | Not created or changed here: external staging producers alone own writes. No box operation or producer change was assigned | RELEASE.md:42 |
| W2 lost-session post-commit recovery conflict | Not repaired; retained literal STOP behavior, no workaround selected; see below | RELEASE.md:190 and RELEASE.md:1453 |

The machine-read section is RELEASE.md:162 through RELEASE.md:584.
Counts include manual and conditional rows, including failure-only aborts;
they are not counts of unconditionally executed commands. W6e still uses W6
INPUTS.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 9 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 21 | 2 | 8 |

No alternative W1/W2/W2b run order was selected. The W2 incomplete-prefix
case is explicit: ai-w2-reconcile records schema-prefix.json and exits STOP
(RELEASE.md:2781). The generated recovered-close order never authorizes
skipping that refusal. A pre-fence close uses ai-close's existing
zero-new-ledger check; a complete prefix with failed initial issuer
provisioning retains the schema and rolls back only that credential.

One definite existing conflict remains for a LOST box session after a W2
commit. Execution ruling 2 requires a new persistent root shell and the whole
ai-db-session block (RELEASE.md:190). That block writes ledger-before.txt
and requires its hash to equal INPUTS baseline_ledger_sha256
(RELEASE.md:1453). After any new ledger commit, it STOPs before
establishing ai_run, so that new shell cannot reach ai-w2-reconcile through
the prescribed whole-block route. The two possible readings are (1) run the
whole prescribed block and retain that refusal, or (2) initialize recovery
helpers without the original baseline check. No marked block or ruling
authorizes (2); no bypass, alternate block or INPUTS change was chosen.
HezLead must rule or assign a repair if successful post-commit recovery in a
replacement shell is required. This is separate from the original-shell
recovery order and was not exercised as a live incident.

The Mac reads INPUTS_FILE's existing sibling box evidence
`measurements-baselines-<window>.json` (the retained production preparation
carrier uses baselines/ledger/measured_at_utc). For STG, it also requires that
measurement's release_sha/window/window_id and inputs_sha256 to bind the exact
INPUTS bytes, matching reported baselines, an age of 0–300 seconds and the exact
staging_marker object defined in the Inputs section. It never reads the Mac's
marker to authorize STG and never requires STG for a production window. The
external staging producer must now retain that bound marker measurement in
this carrier; the current producer was read, not modified or run. A missing
measurement fails closed. No INPUTS schema key was added.

Tests protect the generator's release-artifact contract, marker admission
at the real extracted block boundary, and external-only marker ownership.
Host selection, the marker read path and test-fixture ownership are rewritten
once each for portable fixture execution; tests never write the real /etc path.
New fixture-file removals invoke the installed rm guard. A baseline control
executed HEAD's exact ai-inputs Python and confirmed it accepted STGabc without
staging evidence (exit 0); current tests refuse it alongside a passing ordinary
id. Control receipt: `scratchpad/c1-8/baseline-control.log`.

Focused admission/ownership check: **2 tests, 2 pass, exit 0**. Generator
check: **8 tests, 8 pass, exit 0**; the final gate repeats all eight against the
final plan bytes, including every condition on manual rows. The final named
gate (no skipped tests):

```sh
C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh
```

**172 tests, 172 pass, exit 0**. Log: `scratchpad/c1-8/gate.log`;
exit receipt: `scratchpad/c1-8/gate.exit`. The earlier gate also passed
172/172; its receipts are gate-initial.log and gate-initial.exit in that folder.
Final gate tail:

```text
ℹ tests 172
ℹ suites 0
ℹ pass 172
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 209445.336125
```

`git diff --check` passed. No in-scope item is awaiting a tool/service refusal.
The external producer handoff and the existing W2 replacement-session conflict
are stated above; neither is a claim that this patch has run on a box.
