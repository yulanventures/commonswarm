# Frozen bundle status (lane/c1-frozen-work)

Branch `lane/c1-frozen-work`, based on origin/main `a5cb8251`. HezLead owns
review and integration. Committed HEAD is `37495409` (C1-8): C1-1 TODO
repairs are in `1c5d4dbc`, generator/run orders in `edf4a3bf`, C1-4 repairs in
`69fa19f7`, W4 Caddy repair in `03c3c9d4`, C1-6 in `6ca8f36e`, and C1-7 in
`d965371b`. C1-9 below is the uncommitted patch on C1-8. This worker does not
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

## C1-9 supersede lock order (uncommitted on C1-8)

Grok round 4 at
`/Users/yulanbot/work/c1-verify/review/runs/20261006T003428Z-169c7a/grok/result.md`
refuted C1-7's claim about human revoke: with a live approval, supersede held
verification FOR UPDATE and waited for the binding-owner account, while human
revoke/suspend held that account and requested verification FOR SHARE through
the terminal-binding fence. C1-7 now serves as a real `40P01` negative control.
C1-6 remains the control for approvals-table-before-account inversion.

The new supersede reads the active version's approvals FOR SHARE after RESET
ROLE and raises the existing exact live-approval FAIL before requesting any
account lock. Only a version change with this owner's withdrawn approval and
no owner's live approval proceeds. It then prelocks every binding owner's
account in owner order, locks approvals SHARE ROW EXCLUSIVE, and checks again
for a live approval before restoring commonswarm_admin_release for writes.
The second check covers an absent-row insertion between the first read and
the table lock. No database privileges change. Same-version and first-insert
paths do not take the account prelocks or approvals table lock.

### Full lock-order table

Row locks are named below; ordinary DML table locks, unique conflicts and FK
checks are included where relevant. All locks last through transaction end.

| Path | Locks in acquisition order |
| --- | --- |
| C1-6 supersede control (`6ca8f36e`) | cutover singleton FOR UPDATE; active verification FOR UPDATE; approvals table SHARE ROW EXCLUSIVE; approvals FOR SHARE; verification UPDATE; fence verification FOR SHARE (preowned); binding-owner account FOR UPDATE; grant FOR UPDATE; binding FOR UPDATE; tombstone INSERT/unique conflict check |
| C1-7 supersede control (`d965371b`) | cutover singleton FOR UPDATE; active verification FOR UPDATE; RESET ROLE; all binding-owner accounts FOR UPDATE in owner order; approvals table SHARE ROW EXCLUSIVE; approvals FOR SHARE and live check; restore release role; verification UPDATE and the fence below; verification INSERT/active-version unique check |
| C1-9 supersede | cutover singleton FOR UPDATE; active verification FOR UPDATE; RESET ROLE; active-version approvals FOR SHARE and owner's approval FOR SHARE; **live-approval refusal before accounts**; all binding-owner accounts FOR UPDATE in owner order; approvals table SHARE ROW EXCLUSIVE; **live-approval recheck**; restore release role; verification UPDATE (ROW EXCLUSIVE table lock); per binding in owner/grant order: fence verification FOR SHARE (preowned), account FOR UPDATE (preowned), grant FOR UPDATE, binding FOR UPDATE; terminal grant/binding writes where live; tombstone INSERT ON CONFLICT DO NOTHING; verification INSERT/active-version unique check |
| Human approve | exact verification FOR SHARE via lock_admin_client_verification; owner swarm.users FOR UPDATE; account INSERT ON CONFLICT/unique check then FOR UPDATE; owner's grants FOR UPDATE in grant order; exact approval FOR UPDATE (ROW SHARE table lock); rate buckets INSERT/UPDATE in sorted key order; event INSERT; grant upserts and consumed-consent/account UPDATE; approval INSERT (ROW EXCLUSIVE table lock), evidence SELECT and FK KEY SHARE on prelocked account/verification plus event; command-result INSERT |
| Human withdraw approval | exact verification FOR SHARE; user FOR UPDATE; account INSERT/unique check and FOR UPDATE; owner's grants FOR UPDATE in grant order; exact approval FOR UPDATE; sorted rate buckets; event INSERT and grant/consent/account persistence; approval UPDATE (ROW EXCLUSIVE table lock); evidence SELECT; per binding in grant order: fence verification FOR SHARE (preowned), account FOR UPDATE (preowned), grant FOR UPDATE (preowned), binding FOR UPDATE; terminal writes and tombstone INSERT/unique conflict check; command-result INSERT |
| Human revoke delegation | user FOR UPDATE; account INSERT/unique check and FOR UPDATE; owner's grants FOR UPDATE in grant order; membership/workspace FOR SHARE for required current rights; sorted rate buckets; event INSERT; terminal grant upsert; family trigger live binding UPDATE with guard grant FOR SHARE (preowned); terminal-binding fence verification FOR SHARE, account/grant FOR UPDATE (preowned), binding FOR UPDATE; tombstone INSERT/unique conflict check; terminal audit INSERT with FK KEY SHARE on account/grant/binding; consumed-consent/account UPDATE; command-result INSERT |
| Human suspend delegation | same human prefix as revoke: user FOR UPDATE; account INSERT/unique check and FOR UPDATE; owner's grants FOR UPDATE in grant order; rights membership/workspace FOR SHARE; sorted rate buckets; event INSERT; suspended grant upsert; family trigger live binding UPDATE with guard grant FOR SHARE (preowned); terminal-binding fence verification FOR SHARE, account/grant FOR UPDATE (preowned), binding FOR UPDATE; tombstone INSERT/unique conflict check; terminal audit FK KEY SHARE; consumed-consent/account UPDATE; command-result INSERT |
| OAuth revokeFamily | issuer-key transaction advisory lock via issuer_key_allowed; lock_admin_consent_policy: exact verification FOR SHARE, account FOR UPDATE, live approval FOR SHARE; bridge account INSERT/unique check, account FOR UPDATE (preowned), owner's grants FOR UPDATE in grant order; exact binding FOR UPDATE; fresh browser session FOR SHARE; sorted rate buckets; membership/workspace FOR SHARE for current rights; event INSERT; grant upserts with family/binding/tombstone triggers, consumed-consent/account UPDATE; explicit fence verification/account/grant/binding locks (preowned), tombstone INSERT/unique check; terminal OAuth audit INSERT/FK KEY SHARE |

Sources: `supabase/functions/command/admin-delegation.ts`, migrations
`20261003000001_admin_oauth_bindings.sql`, `20261003000002_admin_oauth_policy.sql`
and `20261003000003_admin_oauth_cutover.sql`, and
`services/mcp-auth/src/admin-lifecycle.js` plus `admin-authority.js`.

### Supersede versus each path

- **Approve:** same-version verification FOR SHARE precedes any account lock,
  so approve waits at verification if supersede wins, or supersede waits there
  without accounts if approve wins. A different-client approve sharing a
  binding owner serializes at that account before supersede's approvals table
  lock. If approve wins the account, its approval INSERT can finish: the early
  approval read takes ROW SHARE, compatible with ROW EXCLUSIVE. If supersede
  wins the account, approve cannot reach the table write. An unrelated owner's
  write can wait on the broad table lock but holds no account/grant/binding
  supersede needs. Absent-row insertions are covered by the table lock and recheck.
- **Withdraw:** same-version verification FOR SHARE likewise comes first,
  including before the approval row UPDATE lock, so the early FOR SHARE read
  cannot wait on a withdrawal that is itself waiting for this verification.
  On another client, a shared owner serializes at the account before the table
  lock; other owners hold disjoint downstream rows. Withdrawal's real fence
  terminalizes all matching bindings and inserts tombstones in the same commit.
- **Revoke:** with any live approval on the active version, supersede aborts
  before accounts; it cannot wait on the account while revoke's late fence
  waits on its verification. Without live approvals, committed withdrawal has
  terminalized bindings and inserted tombstones. A terminal grant is idempotent;
  a suspended grant can become revoked, but the family trigger skips terminal
  bindings and its existing tombstone INSERT conflicts without firing the
  AFTER INSERT fence. Thus that revoke takes no late verification lock. For
  another client, any late verification lock is on that other row; the shared
  account serializes remaining grant/binding/audit work before the table lock.
- **Suspend:** the same early live-approval refusal eliminates its account to
  verification cycle. With approvals withdrawn, the binding is already terminal
  and tombstoned, so a permitted terminal grant transition cannot acquire this
  verification via either a live-binding UPDATE or new tombstone INSERT.
  Another-client suspend serializes on a shared account or uses disjoint rows.
- **OAuth revokeFamily:** lock_admin_consent_policy takes verification FOR SHARE
  before the account, including when the approval is withdrawn. The same-row
  contender therefore waits before accounts in either ordering. Another-client
  revocation serializes at any shared binding-owner account. Supersede takes no
  issuer-key advisory, browser-session, rate-bucket or rights lock, so those
  extra OAuth locks cannot supply a return edge.

These are five pairwise proofs against supersede under durable production
invariants, not a global deadlock claim among all command/lifecycle operations.
All binding-owner accounts exist through binding -> grant -> account FKs.
EXISTS prelocks each once, including terminal bindings; verification FOR UPDATE
blocks a new binding's FK FOR KEY SHARE, so that set cannot grow while locked.
Nested binding/tombstone triggers re-enter the same fence. Each grant has one
binding (UNIQUE admin_grant_id), so reentry adds no other owner or verification.
Audit FK checks revisit account/grant/binding. Terminal audit takes no cutover
row lock; issued/rotated audit does. The grant legacy guard reads cutover
without a row lock. Supersede does not take user, rate-bucket, rights,
command-result, issuer-key or provider-resource advisory locks.

### Rehearsal and gate evidence

The existing migrated-schema retry test owns these races. Both contenders use
real PostgreSQL connections with triggers/FKs enabled. Only seed preparation
uses replication mode. Supersede executes SQL generated from the actual plan
block; controls generate SQL from exact committed C1-7/C1-6 plan bytes. The
human contender executes the command's verification/user/account/grant/approval
lock sequence and guarded approval evidence INSERT, or the terminal grant UPDATE
that its persistEvents upsert reaches. Rate charges, human revoke/suspend event
persistence, reducer execution and HTTP authentication are not rehearsed; those
omitted operations add no supersede-owned lock. Observer connections establish
actual waits with pg_blocking_pids. Account-first success-path supersedes execute
UPDATE/INSERT then ROLLBACK to preserve the fixture; the final supersede-first
race COMMITs the generated transaction and the human approval.

Focused PostgreSQL 17 retry rehearsal: **1 test, 1 pass, exit 0**
(`RUN_PG_REHEARSAL=1 node --import tsx --test --test-name-pattern='c1 W6 retry:' tests/c1-w2-rehearsal.test.ts`).

| Rehearsal | Result |
| --- | --- |
| C1-7 bytes, revoke owns account with live approval | Actual account wait followed by PostgreSQL `40P01`; one contender aborts; control survivor rolls back |
| C1-9 bytes, revoke owns account with live approval | Exact live-approval FAIL at verification_version 1 before accounts; revoke COMMIT; no `40P01` |
| C1-9 bytes, suspend owns account with live approval | Same exact refusal; suspend COMMIT; no `40P01` |
| C1-9 bytes, revoke owns account after approvals withdrawn/bindings terminal | Supersede waits on account; revoke COMMIT; supersede UPDATE/INSERT complete then test ROLLBACK; no `40P01` |
| C1-9 bytes, different-client approve owns account | Supersede waits on account; guarded human evidence/approval INSERT completes then test ROLLBACK; supersede UPDATE/INSERT complete then test ROLLBACK; no `40P01` |
| C1-6 bytes, supersede owns approvals table first | Actual inverse waits followed by PostgreSQL `40P01`; control transactions roll back |
| C1-9 bytes, supersede owns binding-owner accounts first | Both account probes hit lock_timeout; different-client approve waits on account; both COMMIT; no `40P01` |
| Missing-tombstone insert proof | Count delta **+2 (0 -> 2)** after the final real deactivation fence; no pre-seeded tombstone can satisfy it |
| Fresh-owner approvals insertion | Removing table lock permits INSERT; keeping it waits until transaction end; same INSERT then succeeds |

The first focused run exposed mismatched fixture grant/binding consent times,
which hit `23514` before the control fence; the fixture now copies consent and
expiry times from its grant and uses matching scope_names. The second run
exposed a fixture event sequence collision; approval events now use sequence
2 after withdrawal's sequence 1. The final focused run passed all races above.
The release-role approval-read and account-lock privilege probes remain false.

Required gate (the exact assigned command):

```sh
C1_GATE_EXTRA=tests/c1-task-from-plan.test.ts bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh
```

**172 tests, 172 pass, exit 0**. No skipped tests. Exact gate tail:

```text
ℹ tests 172
ℹ suites 0
ℹ pass 172
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 197875.863541
```

Changes with file:line:

- `RELEASE.md:4789`: active-version approvals FOR SHARE precede account locks;
  `RELEASE.md:4791`: exact live-approval refusal;
  `RELEASE.md:4792`: deterministic account prelock, approvals table lock and
  live-approval recheck, then restore the release role for UPDATE/INSERT.
- `tests/c1-w2-rehearsal.test.ts:426`: binding fixture scope/consent/expiry facts
  match the grant; `:452`: shared two-connection helper; `:541`: account-first
  revoke/suspend/approve races and exact C1-7 control; `:625`: real withdrawal;
  `:640`: observable tombstone INSERT delta.
- `FROZEN-BUNDLE-STATUS.md:278`: corrected C1-7 claim, full eight-path lock-order
  table, five pairwise arguments, rehearsal results and this gate receipt.

`git diff --check` passed. Source/tooling changes: **0 lines**; executable
plan: **9 added / 9 removed**; tests: **128 added / 14 removed**. Only the two
assigned documents and their existing rehearsal test changed.

HezLead owns the independent cross-family check and integration. No commit,
push, full suite, build, Docker, browser or production operation is authorized
or claimed. `VERIFY-HARNESS.md` stays outside this assignment.

## C1-8: W1/W2/W2b run orders and STG reservation (2026-10-05)

Historical C1-8 report, prepared on `d965371b` and now committed by the Lead
as `37495409`. That patch was limited to RELEASE.md, this status file,
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

## C1-12: nine Grok-sweep findings (uncommitted on lane/c1-frozen-work)

Prepared against frozen `86673f1f`. No commit, push, production operation,
full suite, build, Docker or browser. HezLead owns independent review.

Changed step counts (manual and conditional rows included, as in C1-8):

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

W5 recovered-close gained `ai-w5-recovery-env` (9→10). W7 forward gained
`ai-w7-timer-hold` (21→22). W7 rollback and recovered-close keep their lengths
but dispatch `ai-w7-recovery` instead of `ai-emergency-close`.

| Finding | Status | Plan locus |
| --- | --- | --- |
| W4-PREFLIGHT-MEM-JSON | done | `ai-w4-preflight` `mem_bytes=int(mem)` L3522-3524 |
| W4-CAND-LOG-ANCHOR | done | `ai-w4-caddy-candidate` prefixes `request>headers`,`resp_headers` L3599-3602 |
| W4-META-REWRITE | done | rewrite without extra `/admin` L3583; GET-only `@admin_metadata` L3578-3585; probes GET 200 / HEAD 405 L3748-3766 |
| W5-RECOVERED-CLOSE-UNBOUND | done | `ai-w5-recovery-env` L4580-4627; recovered-close order before `ai-close` L409-410 |
| W5-RECOVERY-TRANSFER-RETRY | done | exclusive-create tar L4481-4497; resume proof/upload/tar L4514-4534, L4554-4558 |
| W7-GATES | done | Mac `ai-gates` L531; box digest bind L6067-6099; `ai-w7-proof` has no `ai_run ai-gates` L6106-6128 |
| W7-STAGE | done | box mktemp `/tmp/anvil-secret` L958, L1324, L3916; Mac `/private/tmp/anvil-secret` stays L26, L5477, L5505, L5537, L5867; close cleanup `/tmp` L6498-6500, L6533 |
| W7-KEEPOPEN | done | quote L5964, L6003, L6181; `ai-w7-recovery` L5999-6042; W7 rollback/recovered-close orders L555, L560 |
| W7-TIMER | done | `ai-w7-timer-hold` L5971-5995; proof inactive checks L6112-6113 before `W7_C1_BINDING` L6114; `ai-close` restore before `closed.txt` L6487-6491 |

W7-STAGE box paths changed from `/private/tmp/anvil-secret` to `/tmp/anvil-secret`: `EDGE_QUERY_STAGE` L958/L962, `ai-open` `SECRET_STAGE` L1324, `HOOK_SECRET_STAGE` L3916/L3921, `ai-w2-between-probes` L2444 and L2557, `W2_REMOTE_SCRIPT` L2003, `ai-close` cleanup L6498-6500 and L6533. Mac `C1_SECRET_STAGE` and W6 pointer/agent-receipt/secret-close regexes stay `/private/tmp/anvil-secret`. Denied-list still names `/private/tmp/anvil-secret.abcdef` so a Mac leftover cannot pass the box closer.

### Gate

Exact assigned command:

`C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh`

from `/private/tmp/cs-c1-frozen`. Exit 1 immediately:

`mktemp: mkdtemp failed on /tmp/lane-home.nTNsOQ: Operation not permitted`

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.iso`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 161
ℹ pass 160
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 258733.800833
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. HEAD remains `86673f1f`.

## C1-13: rehearsal regression, staging abort, and five refuter findings (uncommitted)

Prepared against frozen `86673f1f` plus uncommitted C1-12. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent review.
PG rehearsal is left for the Lead.

Changed step counts (manual and conditional rows included, as in C1-8):

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

W2 recovered-close still has 11 rows: `ai-w2-issuer-rollback` is a manual omit-unless-marker
instruction, not a dispatched block. W2b recovered-close stays 9 on the same pattern.
W2 forward keeps abort, session and stage-probes (21). Live smoke uses granular consent;
the existing full-account second-confirmation tests are unchanged and the live smoke no
longer exercises that control.

| Item | Status | Plan locus |
| --- | --- | --- |
| 1 C1-12 W6 rehearsal edge-measurement | done (rehearsal remap) | `scripts/c1-w6-rehearsal-steps.sh` remaps `/private/tmp/anvil-secret` first, then `/tmp/anvil-secret` |
| 2 ai-open-abort absent secret-stage.path | done | `ai-open-abort` L6606-6624 |
| 3 box-hosted `/private/` guard | done | close denied-list `NEGATIVE-CONTROL /private/` L6573; test fails on 86673f1f |
| 4 W6a-2 EDGE_MEASUREMENT_FILE + INPUTS_FILE | done | W6 order L427; re-execs pass both in `env=dict` (ai-open, ai-w5-reference, activation-checks, activation-apply, refresh) |
| 5 W6 granular pointer scopes | done | pointer `full_account: False` L5588; browser/producer L5232-5243, L5297, L5621-5622 |
| 6 W2B recovery must not wipe live issuer | done | marker before mutation L2923; rollback refuse L2987-2988; recovered close wipe only with marker L6524 |
| 7 W2 pre-fence close / refuse-before-open | done | ai-open refuse-before-mkdir L1219-1257; ledger-at-open L1366-1371; close compares capture L6515-6520 |

Root cause for item 1: C1-12 moved box stages to `/tmp/anvil-secret`. The rehearsal still
remapped only `/private/tmp/anvil-secret`. On Darwin `/tmp` is a symlink to `/private/tmp`,
so the edge-receipt query EXIT trap `p.resolve()==p` failed and the parent reported
`FAIL edge-measurement.json: current release_generation/invalidated_at unavailable`.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.cwoDha: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.mYNgbn`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 166
ℹ pass 165
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 211943.202541
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. HEAD remains `86673f1f`. PG rehearsal left for the Lead.

## C1-14: W6 retry/recovery idempotency (uncommitted)

Prepared against frozen `86673f1f` plus uncommitted C1-12 and C1-13. No commit,
push, production operation, full suite, build, Docker or browser. HezLead owns
independent review. PG rehearsal is left for the Lead.

Changed step counts (manual and conditional rows included, as in C1-8): **none**.
No run-order rows were added or removed.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

Harness edits (not in the allowed plan-only list; listed for the checker):
`scripts/c1-w2-rehearsal.sh` `exec 3>&1` and `die` to fd 3 (L100-101);
`scripts/c1-w6-rehearsal-steps.sh` unique `ai-close` general-timer extract plus
once-count control (L541-545).

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 0 W6 rehearsal extract uniqueness + die visibility | done (harness) | unique FAIL `re-arm with ai-w4-timer-recovery` L541-545 of `scripts/c1-w6-rehearsal-steps.sh`; `die` `>&3` L100-101 of `scripts/c1-w2-rehearsal.sh` |
| 1 W6B2-1 atomic C1-audit.json | done | `ai-w6-audit` staging mktemp/validate/`mv -f` L5727-5738; Mac probe `test -s` L5842 |
| 2 W6B2-2 / W6b1-2 reuse revoke-request-id | done | `ai-w6-human-revoke` reuse saved UUID, skip CLI when receipt already revoked L5900-5952; emergency-close still has no mint — recovery is `C1_RECOVERY_REVOKE=1` |
| 3 W6B2-3 reuse owner-client command id | done | `ai-w6-owner-client-command` lstat saved id, matching completed receipt, exclusive create only when absent L5558-5606 |
| 4 W6b1-1 recoverable transfer | done | leftover owner-matched regular `/tmp/admin-c1-${WINDOW_ID}-${file}` replaced then removed L5441-5466; downloads stage then publish L5468-5504 |
| 5 W6b1-3 redundant HEAD `body==b''` | not done | left in place (light review UNPROVEN; not trivially safe) |

Tests interrupt at the named point; frozen `86673f1f` bytes fail the same fixture.

Run-order quote pins retargeted after the W6 block growth (not new rows):
`ai-open-abort` 6603→6718; fence dispatch 5753→5834; `ai-w6-secret-close` 5926→6041;
browser-worker manual 5621→5695; close LOG.md manual 6655→6770.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.b8UUZw: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.c114inner`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 170
ℹ pass 169
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 201136.348625
INNER_RC=0
```

The C1-14 extract uniqueness test in `tests/c1-w2-rehearsal.test.ts` passed in a separate inner run without `RUN_PG_REHEARSAL=1` (PG tests skipped). PG rehearsal is left for the Lead.

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. Frozen SHA remains `86673f1f`.

## C1-16: checker round 6 (uncommitted)

Prepared against committed HEAD `00e4fca4`. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent
review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for the Lead.

Changed step counts (manual and conditional rows included, as in C1-8): **none**.
No run-order rows were added or removed.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

Harness edits (not in the allowed plan-only list; listed for the checker):
`tests/admin-release-plan-sandbox.test.ts` first `Mac|box` token classifier,
EXPECTED_MAC_STEPS/MUST_PASS without `ai-w7-proof`, `ai-live-controls` and
`ai-edge-receipt`, ssh mktemp stubs for `/tmp/admin-c1.XXXXXX` and kin.
No `scripts/c1-task-from-plan.mjs`, `scripts/c1-w2-rehearsal.sh` or
`scripts/c1-w6-rehearsal-steps.sh` edits.

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 EDGE_MEASUREMENT_FILE as argv | done | ai-open/ai-w5-reference/ai-w6-activation-checks/ai-w6-activation-apply pass `"$EDGE_MEASUREMENT_FILE"` as argv[3] L1282, L4300, L4784, L5052 |
| 2 revoke receipt binds grant_id + request_id | done | ai-w6-human-revoke match requires both L5932; CLI publish validates both L5968 |
| 3 atomic receipts; incomplete does not block | done | revoke mktemp+validate+`mv -f` L5958-5970; incomplete prints `incomplete` and continues L5924-5942; owner JS stage+rename L5602-5605 |
| 4 owner receipts bind release/window/plan/owner/action | done | reuse match L5590; producer fields L5601 |
| 5 W5 recovery env capture + unset | done | unset then `out=$(python3 …) \|\| exit 1; eval "$out"` L4637-L4683 |
| 6 W5 transfer compare before write | done | cmp all four files before any install L4594-4607 |
| 7 W7 recovery generation from refresh else W6 | done | `proof/edge-measurement.json` else W6 final L6233-6240; `preserved-*-at-expected-generation` L6250 |
| 8 no success-path `exit 0` in box blocks | done | ai-open-abort if/elif/else L6751-6799; ai-close W5 recovered `else` through last PASS then `fi`; human-revoke recovery `if/else` not `exit 0` |
| 9 mktemp&&pointer plus abort leftover scan | done | ai-open L1373; abort pointer-absent scan L6755-6788 |
| 10 download reuse validates parse + digest | done | ai-w6-transfer parse then `sha256sum` compare L5449-5478 |
| 11 sandbox classifier first Mac\|box token | done (harness) | `hostRole` L41 of `tests/admin-release-plan-sandbox.test.ts`; 31 Mac blocks |
| 12 private mktemp transfer staging | done | `/tmp/admin-c1.XXXXXX` L5428; `/tmp/admin-site-c1.XXXXXX` L4585; `/tmp/admin-site-recovery.XXXXXX` L4610; `/tmp/admin-c1-ready.XXXXXX` L4726 |

Tests interrupt at the named point; frozen `00e4fca4` bytes fail the same fixture.

Run-order quote pins retargeted after block growth (not new rows):
`ai-w2-reconcile` 1913→1912; issuer rollback 2894→2893 and 3054→3053;
`ai-w3-probes` 3396→3395; `ai-w4-rollback` host 3909→3908; W2 manual 1922→1921
and 2988→2987; BROWSER-READY manual 5282→5270.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.VKYBdO: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.vEN7wP`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 180
ℹ pass 179
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 208109.193125
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. HEAD remains `00e4fca4`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-17: checker round 7 (uncommitted)

Prepared against committed HEAD `6f4a0ac9`. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent
review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for the Lead.

Changed step counts (manual and conditional rows included, as in C1-8): **none**.
No run-order rows were added or removed.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

No `scripts/c1-task-from-plan.mjs` edits.

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 W7 opening receipt persisted then consumed | done | ai-open retains `PROOF_DIR/edge-measurement-open.json` at 0600 with the same digest L1377-1401; ai-w7-recovery prefers it when generation >= W6 final else uses W6 final, and refuses a stale opening L6316-6324 |
| 2 abort lists, never deletes, unpointed stages | done | mtime scan and `os.rmdir` removed; absent pointer lists `/tmp/anvil-secret.??????` (uid 0 or euid, 0700, empty) and records "no secret stage was recorded; candidates listed for manual review" L6839-6863; recorded pointer still removes only that stage |
| 3 two retained revoke receipts | done | matching `human-revoke.json` moves leftover `human-revoke-recovery.json` to `PROOF_DIR/incomplete/` (0700) with a reason and does not parse it L5996-6034 |
| 4 W5 recovery tar vs retained tree | done | existing dest compared to tar file list and digests; identical skips extract; any difference refuses L4646-4679 |

Tests drive the real extracted producer/consumer blocks. HEAD `6f4a0ac9` bytes fail the same fixtures.

Run-order quote pins retargeted after block growth (not new rows):
abort host 6748→6832; LOG 6820→6900; `ai-w6-secret-close` 6063→6146;
W5 recovered prose 4498→4523; site2 table 4494→4519 and 4495→4520;
`ai-w4-timer-recovery` 3908→3933; `ai-w3-probes` 3395→3420; issuer
rollback 2893→2918 and 3053→3078; issuer FAIL 2987→3012; W2 reconcile
1912→1937 and 1921→1946; BROWSER-READY 5270→5322.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.4JKin3: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.uvgnBz`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 183
ℹ pass 182
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 217666.191125
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. HEAD remains `6f4a0ac9`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-18: recovered-close rollback restore and attestation isolation (uncommitted)

Prepared against committed HEAD `6f4a0ac9`. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent
review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for the Lead.
C1-17 changes are kept.

Changed step counts (manual and conditional rows included, as in C1-8): **none**.
C1-13 had replaced the recovered-close rollback steps with manuals of the same
count; C1-18 restores real steps in those same slots.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 W2/W2b recovered-close dispatches real `ai-w2-issuer-rollback` | done | orders L236 and L277; `when` quotes ownership marker L2987; generator refuses a run-order manual that quotes `FAIL ` or names a defined `ai-` step to Run (`scripts/c1-task-from-plan.mjs` expand); extracted rollback then close in `admin-release-plan.test.ts` |
| 2 attestation isolation | done | `ai-w2-backfill` after the row loop: refuse `c1-staging` on a production box; pin 2026-10-04 canonical sha256 `b17a55e8c078945af8df0c56dcb272682d1e22fb7318b529a633cf9468d70031` for 20260916000001/20260916000002; staging marker requires `pointer` to start with `c1-staging/` |

Run-order quote pins retargeted after the isolation insertion (+41, not new rows):
abort host 6832→6873; LOG 6900→6941; `ai-w6-secret-close` 6146→6187;
W5 recovered prose 4523→4564; site2 table 4519→4560 and 4520→4561;
`ai-w4-timer-recovery` 3933→3974; `ai-w3-probes` 3420→3461; issuer
rollback 2918→2959, 3078→3119, recovered marker 2946→2987;
BROWSER-READY 5322→5363; browser worker 5748→5789; dispatch 5887→5928.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.gk8BKN: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.UBt9Fy`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 186
ℹ pass 185
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 211515.849458
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). No new test file (D-030 unchanged). No commit or push. HEAD remains `6f4a0ac9`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-19: checker round 8 (uncommitted)

Prepared against committed HEAD `5eec4d5b`. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent
review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for the Lead.
C1-17 and C1-18 changes are kept.

Changed step counts (manual and conditional rows included, as in C1-8): **none**.
No run-order rows were added or removed.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8 |
| W2 | 21 | 5 | 11 |
| W2b | 19 | 3 | 9 |
| W3 | 20 | 2 | 8 |
| W4 | 21 | 3 | 9 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15 |
| W6e | 2 | 2 | 15 |
| W7 | 22 | 2 | 8 |

No `scripts/c1-task-from-plan.mjs` edits.

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 pin C1-17 baselines to 6f4a0ac9 | done | `git show HEAD:` replaced with `6f4a0ac9` plus `cat-file` absence message; guard test refuses `git show HEAD:` / `'HEAD:docs/` as a comparison baseline |
| 2 attestation metadata must be strings | done | `ai-w2-backfill` isolation: present pointer, written_by, reason, attested_by, attested_at must be strings before checks; list/object pointer and list written_by refuse; production rows still pass |
| 3 W5 tree compares dirs and symlinks | done | retained dest walk uses `dirnames+filenames`; tar files/dirs/symlinks compared; extra directory and extra directory-symlink refuse |
| 4 staging-marker writer alias | done | exemption allow-lists `backfill.json` / `backfill-evidence.json` by name; `(proof/'STAGING-ONLY').write_text` after any `proof=` path is a writer |

Run-order quote pins retargeted after isolation (+2) and W5 comparison (+8), not new rows:
abort host 6873→6883; LOG 6941→6951; `ai-w6-secret-close` 6187→6197;
W5 recovered prose 4564→4566; site2 table 4560→4562 and 4561→4563;
`ai-w4-timer-recovery` 3974→3976; `ai-w3-probes` 3461→3463; issuer
rollback 2959→2961, 3119→3121, recovered marker 2987→2989;
BROWSER-READY 5363→5373; browser worker 5789→5799; dispatch 5928→5938.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.3k4xHB: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.xxp88P`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 187
ℹ pass 186
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 211609.328625
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). One new test (HEAD-baseline guard); D-030 still reaches every test file. No commit or push. HEAD remains `5eec4d5b`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-20: plan-defined recovery env for lost-shell recovered close (uncommitted)

Prepared against committed HEAD `cd46463c`. No commit, push, production
operation, full suite, build, Docker or browser. HezLead owns independent
review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for the Lead.

Changed step counts (manual and conditional rows included, as in C1-8):
recovered-close +2 on every window that had a lost-shell `ai-db-session`
(W1, W2, W2b, W3, W4, W6, W6e, W7). W5 recovered-close stays 10
(`ai-w5-recovery-env`). Forward and rollback unchanged.

| Window | Forward | Rollback | Recovered close |
| --- | ---: | ---: | ---: |
| W1 | 16 | 1 | 8→10 |
| W2 | 21 | 5 | 11→13 |
| W2b | 19 | 3 | 9→11 |
| W3 | 20 | 2 | 8→10 |
| W4 | 21 | 3 | 9→11 |
| W5 | 25 | 4 | 10 |
| W6 | 54 | 7 | 15→17 |
| W6e | 2 | 2 | 15→17 |
| W7 | 22 | 2 | 8→10 |

Ruling 2 (line 650) now names Mac-shell loss: `ai-mac-recovery-env` then
`ai-mac-close`. Quote pins after the run-order inserts (+16) and the two
new blocks (+112): abort host 6883→6899; LOG 6951→7079; lost-shell session
632→648; One closer 635→651; W2 apply-time 642→658.

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 box `ai-recovery-env` | done | L6956–7018; unset then `out=$(python3 …) \|\| exit 1; eval "$out"`; sets WINDOW/WINDOW_ID/RELEASE_SHA/PROOF_DIR/RELEASE_ROOT/BOX_ARCHIVE_PATH and SECRET_STAGE only from a valid pointer |
| 2 Mac `ai-mac-recovery-env` | done | L7022–7059; single `/private/tmp/admin-issuance-prep.??????` whose `release.tar` digest equals inputs `archive_sha256`; zero or several refuse |
| 3 recovered-close orders | done | `ai-recovery-env` immediately before lost-shell `ai-db-session`; `ai-mac-recovery-env` immediately before `ai-mac-close`; W5 keeps `ai-w5-recovery-env` |
| 4 generator invariant | done | `scripts/c1-task-from-plan.mjs` refuses a recovered-close lost-shell `ai-db-session` without `ai-recovery-env` immediately before it |
| 5 EXPECTED_MAC_STEPS | done | `ai-mac-recovery-env` before `ai-mac-close`; Mac block count 31→32; not in MUST_PASS |

Tests (pre-change: `cd46463c` has no `# step: ai-recovery-env` / `# step: ai-mac-recovery-env`; recovered-close orders had no `ai-recovery-env` immediately before lost-shell `ai-db-session`):

| Test | file:line | Pre-change |
| --- | --- | --- |
| recovered-close lost-shell `ai-db-session` has `ai-recovery-env` immediately before it | `tests/c1-task-from-plan.test.ts:380` | absent; `cd46463c` W2 recovered-close has `ai-db-session` and no `ai-recovery-env` |
| lost-shell recovery env reaches session and close; mismatch, wrong id, absent stage and prep dirs refuse | `tests/admin-release-plan.test.ts:3753` | absent; `block('ai-recovery-env')` would fail uniqueness |
| W2/W2b/W7 recovered-close lengths | `tests/c1-task-from-plan.test.ts:285–307` | 11 / 9 / 8 |
| box secret-window regex count | `tests/admin-release-plan.test.ts:147` | 8 (`r'/tmp/anvil-secret\.`) |
| whole-plan portable stage count | `tests/admin-release-plan.test.ts:448` | 11 |

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.fvtJSA: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.tLqvpC`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 189
ℹ pass 188
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 219380.886125
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). Two new tests (extracted recovery-env; generator order). D-030 still reaches every test file. No commit or push. HEAD remains `cd46463c`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-21: checker round 10 (Codex FAIL) on the recovery env (uncommitted)

Prepared against committed HEAD `4f5ecf0e` (worktree `lane/c1-frozen-work`). No commit,
push, production operation, full suite, build, Docker or browser. HezLead owns
independent review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for
the Lead.

ai-db-session reads WINDOW, PROOF_DIR, RELEASE_ROOT, SECRET_STAGE, INPUTS_FILE
(and writes EDGE_RECYCLE_TIMER / EDGE_RECYCLE_SERVICE / PSQL_IMAGE from
INPUTS_FILE). ai-close (non-W5 recovered) reads WINDOW, CLOSE_RESULT, PROOF_DIR,
PLAN_FILE, INPUTS_FILE, BOX_ARCHIVE_PATH, SECRET_STAGE, EDGE_RECYCLE_TIMER
(session-set). Recovery now sets every one of those except CLOSE_RESULT (the
close outcome input) and the session-derived timer/service/image.

| Item | Status | Plan/harness locus |
| --- | --- | --- |
| 1 PLAN_FILE recovered | done | `ai-recovery-env` L7006–7009, L7024, L7029: retained `RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md` whose sha256 equals inputs `plan_sha256`; refuse digest-mismatch |
| 2 ancestor symlink | done | L6967–6978 `resolved()`: `os.path.realpath(p)==p` and each path component checked for PROOF_DIR and RELEASE_ROOT |
| 3 early unset | done | L6960 box outputs first, before any `:?`; L7037 Mac `unset PREP_DIR` before INPUTS_FILE check. Operator inputs WINDOW/WINDOW_ID/INPUTS_FILE kept |
| 4 absent pointer refuses | done | L7012 exact `FAIL ai-recovery-env: secret-stage.path expected recorded-stage got absent; use ai-open-abort; STOP` |
| 5 real session+close | done | `tests/admin-release-plan.test.ts:3873` extracted `ai-db-session` then `ai-close`; stub only docker/systemctl; operator inputs only through `PASS window closed recovered` |
| 6 FAIL text | done | L6995 `0700 owner-matched` matches uid `0` or `geteuid()`; tests stay non-root without remapping |
| 7 LOG quote pin | done | run-order manuals `"line":7079` → `7090` (recovery block grew by 11 lines) |

Tests (pre-change at `4f5ecf0e`, Codex CHECK-C1-10 probes):

| Item | Test | Pre-change |
| --- | --- | --- |
| 1 PLAN_FILE | `tests/admin-release-plan.test.ts:3873` full chain | FAIL `PLAN_FILE: unbound variable` after `PASS ai-db-session`; close succeeded only when PLAN_FILE was supplied |
| 2 ancestor | `tests/admin-release-plan.test.ts:3921` | PASS; `PROOF_DIR.resolve()!=PROOF_DIR` still accepted |
| 3 early unset | `tests/admin-release-plan.test.ts:3942` box; `:3995` Mac | box empty INPUTS_FILE kept RELEASE_SHA/PROOF_DIR/RELEASE_ROOT/BOX_ARCHIVE_PATH/SECRET_STAGE; Mac kept PREP_DIR=/old |
| 4 absent pointer | `tests/admin-release-plan.test.ts:3889` | recovery PASS without SECRET_STAGE; actual session then `SECRET_STAGE: unbound variable` |
| 5 real blocks | `tests/admin-release-plan.test.ts:3753` | C1-20 stubs `reached_ai_db_session` / `reached_ai_close`; missed finding 1 |
| 6 root-owned | `tests/admin-release-plan.test.ts:3768` | FAIL text `0700-root-owned` while uid check allowed `geteuid()` |

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.a40xax: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.rSbkaH`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 189
ℹ pass 188
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 196361.388041
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). C1-20 drive-through now runs extracted `ai-db-session` and `ai-close`. D-030 still reaches every test file. No commit or push. HEAD remains `4f5ecf0e`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-22: two plan defects from staging E16 at F7 (uncommitted)

Prepared against committed HEAD `888d130b` (worktree `lane/c1-frozen-work`). No commit,
push, production operation, full suite, build, Docker or browser. HezLead owns
independent review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for
the Lead.

### Defect 1: W2/W2b issuer fresh check (RELEASE.md:3025)

`supabase/migrations/20261003000002_admin_oauth_policy.sql:48` creates
`commonswarm_admin_issuer LOGIN` with no password. `ai-w2-issuer-credential`
treated only `NOT rolcanlogin AND rolpassword IS NULL` as fresh, so a database
that is exactly the migration start state could never pass.

Fix: ISSUER_FRESH is `rolpassword IS NULL` plus the migration attribute set
(NOINHERIT, NOCREATEDB, NOCREATEROLE, not super, no replication, no bypassrls).
`rolcanlogin` may be either value. A password still refuses. Rollback still
proves NOLOGIN-without-password; the post-provisioning SCRAM readback is
unchanged.

| Item | Status | Locus |
| --- | --- | --- |
| 1 ISSUER_FRESH SQL | done | L3025; FAIL text `fresh-without-password` |
| 2 rollback / close end state | unchanged | still `NOT rolcanlogin AND rolpassword IS NULL` |
| 3 post-provision readback | unchanged | `SELECT rolcanlogin AND rolpassword='<verifier>'` |
| 4 rehearsal FAIL allowlist | done | `scripts/c1-w2-rehearsal.sh` secret_step known-FAIL regex |

Tests (pre-change at `888d130b`):

| Test | file:line | Pre-change |
| --- | --- | --- |
| LOGIN-without-password (migration start) reaches the ownership marker | `tests/admin-release-plan.test.ts:4000` | FAIL `NOLOGIN-without-password`; marker not written |
| NOLOGIN-without-password (rollback end) reaches the marker | `tests/admin-release-plan.test.ts:4000` | PASS (old SQL required NOLOGIN) |
| password refuses | `tests/admin-release-plan.test.ts:4000` | FAIL (kept) |
| inherit-without-password refuses | `tests/admin-release-plan.test.ts:4000` | not defined as fresh |
| w123 used-role refusal text | `tests/admin-release-live-failclosed-w123.test.ts:859` | `NOLOGIN-without-password` |

### Defect 2: lost-shell `ai-db-session` after a schema change (RELEASE.md:1542)

First entry still writes `ledger-before.txt` and checks
`baseline_ledger_sha256`, now with a FAIL line on mismatch. Re-entry (open.txt
already required; `ledger-before.txt` already a regular file) never overwrites
that file. It writes `ledger-at-recovery.txt` (0600, refuse if present) and
accepts live bytes only when they equal the retained ledger or that ledger plus
exactly the versions this window recorded as committed
(`schema-prefix.json` `committed`, else the exact `schema-committed.txt` line,
else `apply-durations.txt`). Any other difference prints the FAIL line.

Run-order quote pins after the session insert (+22) were shifted: 1953→1975,
1962→1984, 2977→2999, 3005→3027, 3137→3159, 3479→3501, 3992→4014, 4578→4600,
4579→4601, 4582→4604, 5389→5411, 5815→5837, 5954→5976, 6213→6235, 6899→6921,
7090→7112.

| Test | file:line | Pre-change |
| --- | --- | --- |
| first entry writes ledger-before; no recovery file | `tests/admin-release-plan.test.ts:4063` | same write; silent `test` on digest mismatch |
| re-entry nothing applied keeps ledger-before | `tests/admin-release-plan.test.ts:4063` | overwrite + digest vs INPUTS (PASS only if live still equals baseline) |
| re-entry after all five W2 versions; ledger-before byte-identical | `tests/admin-release-plan.test.ts:4063` | overwrite; silent set -e death; no FAIL line |
| extra unexpected version refuses with FAIL | `tests/admin-release-plan.test.ts:4063` | silent set -e death |
| leftover ledger-at-recovery.txt refuses | `tests/admin-release-plan.test.ts:4063` | file did not exist |

### Other recovered-close blocks after `ai-db-session` (baseline equals live)

| Block | Assumption | Same defect? |
| --- | --- | --- |
| `ai-close` pre-fence W2 (`apply-started.txt` absent) | live `20261003%` versions equal `ledger-at-open.txt` | No. That path is only pre-fence; after apply the branch is skipped |
| `ai-close` recovered W2/W2b issuer | live role is NOLOGIN without a password | No. That is the rollback end state, not the session ledger baseline |
| `ai-w2-reconcile` (W2 recovered-close, after session) | live ledger equals baseline + recorded prefix from proof files | No. It reads `ledger-after` and `new-migrations.json` / `backfill.json`, not INPUTS `baseline_ledger_sha256` |
| W1 / W2b / W3 / W4 / W6 / W7 recovered-close | no window schema write after the original `ledger-before.txt` | Re-entry `live == ledger-before` holds; no change required |

Harness edits (listed separately): `scripts/c1-w2-rehearsal.sh` secret_step known-FAIL regex only. No change to extract markers (`ISSUER_FRESH=$(ai_ro -Atq`, `>"$PROOF_DIR/ledger-before.txt"`). `scripts/c1-w6-rehearsal-steps.sh` untouched.

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.r70Arp: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.nyfIBE`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 191
ℹ pass 190
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 206487.708833
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). Two new tests (extracted issuer fresh; extracted session re-entry). D-030 still reaches every test file. No commit or push. HEAD remains `888d130b`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-23: checker round 12 (Codex FAIL, 3 blockers) on C1-22 (uncommitted)

Prepared against committed HEAD `21af6cb8` (worktree `lane/c1-frozen-work`). No commit,
push, production operation, full suite, build, Docker or browser. HezLead owns
independent review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for
the Lead.

Run-order quote pins after the session insert (+3) were shifted: 1975→1978,
1984→1987, 2999→3002, 3027→3030, 3159→3162, 3501→3504, 4014→4017, 4600→4603,
4601→4604, 4604→4607, 5411→5414, 5837→5840, 5976→5979, 6235→6238, 6921→6924,
7112→7115.

### Defect 1: issuer fresh omits membership restrictions (RELEASE.md:3028)

`ISSUER_FRESH` still allows LOGIN or NOLOGIN without a password and keeps the
C1-22 attribute set. It now also applies the migration predicates at
`supabase/migrations/20261003000002_admin_oauth_policy.sql:50-56` plus
`pg_shdepend` deptype `a`/`o`: outgoing memberships only in
`commonswarm_oauth_runtime` and `swarm_command` (no ADMIN, no INHERIT, SET
true); incoming memberships only with those allowed options; no direct
privileges or ownership.

| Test | file:line | Pre-change at `21af6cb8` |
| --- | --- | --- |
| extra privileged SET membership (postgres SET) refuses | `tests/admin-release-plan.test.ts:4131` | PASS; writes `issuer-provisioning-attempted.txt` |
| migration outgoing SET memberships pass | `tests/admin-release-plan.test.ts:4131` | not enforced (attributes-only query) |
| `pg_shdepend` a/o refuses | `tests/admin-release-plan.test.ts:4131` | not enforced |

### Defect 2: recovery can miss a committed but unrecorded migration (RELEASE.md:1549)

Re-entry no longer reads `apply-durations.txt`, `schema-prefix.json`, or
`schema-committed.txt` (those can be written after COMMIT). Live must equal
`ledger-before.txt` plus an ordered prefix (empty through all) of
`new-migrations.json`, else `expected-migrations.json` 20261003 versions.
`ai-w2-reconcile` still records the live prefix afterward.

| Test | file:line | Pre-change at `21af6cb8` |
| --- | --- | --- |
| M1 committed without a post-COMMIT record passes | `tests/admin-release-plan.test.ts:4202` | FAIL `ledger-before-or-ledger-before-plus-window-committed` |
| all five with `new-migrations.json` pass | `tests/admin-release-plan.test.ts:4202` | FAIL unless `schema-committed.txt` / durations / prefix is present |
| M2 without M1 refuses | `tests/admin-release-plan.test.ts:4202` | FAIL (same family; now the prefix FAIL line) |
| unexpected version refuses | `tests/admin-release-plan.test.ts:4202` | FAIL `window-committed`; now prefix FAIL line |
| all five with only `schema-committed.txt` refuses | `tests/admin-release-plan.test.ts:4202` | PASS (trusted a post-COMMIT receipt) |

### Defect 3: re-entry bypasses the baseline digest (RELEASE.md:1544)

Re-entry hashes the retained `ledger-before.txt` against INPUTS
`baseline_ledger_sha256` before writing `ledger-at-recovery.txt`.

| Test | file:line | Pre-change at `21af6cb8` |
| --- | --- | --- |
| unexpected first-entry ledger refuses on re-entry | `tests/admin-release-plan.test.ts:4202` | PASS (`live == before`, digest skipped) |

### Non-blocking 3: explicit FAIL lines (RELEASE.md:1541, 1566, 1575)

| Test | file:line | Pre-change at `21af6cb8` |
| --- | --- | --- |
| identity read FAIL line | `tests/admin-release-plan.test.ts:4276` | `ai_ro -q --file /proof/identity.sql >/dev/null` (silent set -e) |
| first-entry ledger read FAIL line | `tests/admin-release-plan.test.ts:4276` | redirect with no `\|\| FAIL` |
| unsupported-step FAIL line | `tests/admin-release-plan.test.ts:4276` | `*) return 2` (status 2, no FAIL line) |

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.Q0TRAA: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.b9VdGG`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 194
ℹ pass 193
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 285530.639958
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). Three new tests (issuer memberships; unrecorded prefix / digest re-entry; identity/ledger/unsupported FAIL lines). D-030 still reaches every test file. No commit or push. HEAD remains `21af6cb8`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-24: checker round 13 (Codex FAIL, 2 blockers) on C1-23 (uncommitted)

Prepared against committed HEAD `2f3b7133` (worktree `lane/c1-frozen-work`). No commit,
push, production operation, full suite, build, Docker or browser. HezLead owns
independent review. PG rehearsal, Caddy, and the Mac sandbox TAP are left for
the Lead.

Run-order quote pins were not shifted: the issuer SELECT and the recovery
Python stay on the same lines.

### Defect 1: issuer fresh omits the rest of DO $issuer$ (RELEASE.md:3028)

`ISSUER_FRESH` still allows LOGIN or NOLOGIN without a password and keeps the
C1-23 attribute, outgoing/incoming option, and `pg_shdepend` predicates. It now
also applies the rest of `DO $issuer$` at
`supabase/migrations/20261003000002_admin_oauth_policy.sql`: duplicate-edge
rejection (`GROUP BY roleid HAVING count(*)<>1`), exactly two outgoing
memberships, and the creator-membership checks (`:63` administrator, `:67`
non-superuser admin-only edge). `rolcanlogin` stays either value. The structural
test extracts each `RAISE EXCEPTION` condition from the migration and requires
a counterpart in the plan query.

| Test | file:line | Pre-change at `2f3b7133` |
| --- | --- | --- |
| second grantor SET edge on `swarm_command` refuses | `tests/admin-release-plan.test.ts:4353` | PASS; writes `issuer-provisioning-attempted.txt` |
| migration two outgoing SET memberships pass (LOGIN or NOLOGIN) | `tests/admin-release-plan.test.ts:4353` | not enforced (no count/duplicate) |
| superuser creator membership refuses; non-superuser admin-only edge passes | `tests/admin-release-plan.test.ts:4353` | not enforced |
| every `DO $issuer$` refusal has a fresh-query counterpart | `tests/admin-release-plan.test.ts:4353` | missing `GROUP BY` / `count(*)=2` / `current_user::regrole` |

### Defect 2: recovery accepts an incomplete retained manifest (RELEASE.md:1549)

Re-entry derives the planned `20261003` sequence from
`$RELEASE_ROOT/supabase/migrations/2026100300000{1-5}_*.sql` (the same glob
`ai-w2-preflight` uses) and requires `new-migrations.json`, else
`expected-migrations.json`, to equal that sequence exactly. A short, reordered
or foreign manifest prints
`FAIL ai-db-session: expected-migration-manifest expected the release 20261003 sequence got other; STOP`
before the prefix comparison.

| Test | file:line | Pre-change at `2f3b7133` |
| --- | --- | --- |
| `new-migrations.json` with only M2, live baseline+M2, refuses before prefix | `tests/admin-release-plan.test.ts:4470` | PASS (prefix of the short list) |
| true five-version `new-migrations.json` with M1 committed passes | `tests/admin-release-plan.test.ts:4470` | PASS (already a prefix of five) |
| reordered five-version manifest refuses before prefix | `tests/admin-release-plan.test.ts:4470` | PASS if live is a prefix of that order |
| `expected-migrations.json` with only M2 refuses before prefix | `tests/admin-release-plan.test.ts:4470` | PASS (filtered list is `[M2]`) |

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.kxpCLZ: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.XXXXXX`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 196
ℹ pass 195
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 201025.371916
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). Two new tests (issuer DO $issuer$ parity and duplicate/creator refusals; short/reordered/foreign manifest before prefix). D-030 still reaches every test file. No commit or push. HEAD remains `2f3b7133`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

## C1-25: box-side ai-gates cannot open Mac gate evidence (uncommitted)

Prepared against frozen `b3181b79`. No commit, push, production operation,
full suite, build, Docker or browser. HezLead owns independent review.

Staging W4 (`ai-w4-apply`) reran `ai_run ai-gates` on the box after both Caddy
candidates validated. `ai-gates` requires `evidence_root` to be an absolute
directory on the host that runs it. The checker's tree lives on the Mac; the
plan never copies it. Production W4 and W6 would stop the same way. C1-12
already bound W7 by digest; this patch applies that pattern to every remaining
box-hosted `ai_run ai-gates` call.

`ai-gates` is unchanged (byte-identical to `b3181b79`) and still runs on the
Mac. New helper `ai-gates-bind` (not-run; allowlisted in `ai_run`) checks
`GATE_RECEIPT_FILE` and `$PROOF_DIR/gates.json` sha256 against INPUTS
`gate_receipt_sha256`, then the receipt `release_sha` and required gate list
against INPUTS and `GATES.json`. It does not open `evidence_root`.

| Call site | Before (`b3181b79`) | After |
| --- | --- | --- |
| `ai-w4-apply` | `ai_run ai-gates` L3814 | `ai_run ai-gates-bind` L3857 |
| `ai-w6-activation-checks` | `ai_run ai-gates` L4931 | `ai_run ai-gates-bind` L4974 |
| `ai-w6-activation-apply` | `ai_run ai-gates` L5200 | `ai_run ai-gates-bind` L5243 |
| `ai-w7-proof` | no `ai_run ai-gates` (C1-12); C1.json vs `admin-c1-smoke` only | `ai_run ai-gates-bind` L6545 plus existing C1.json bind |

W7 C1-12 consistency: C1-12 removed the box `ai_run ai-gates` from `ai-w7-proof`
and added a W7-only C1.json digest check in `ai-w7-preflight`. That did not bind
the receipt bytes or the full `GATES.json` window list. W7-proof now calls the
same helper as W4/W6; the C1.json smoke bind stays.

Inserting the helper shifted later `when`/`manual` quote line pins (not-run +1;
helper +42; W7 extra `ai_run` +1). Pins were retargeted to the same quotes in
preamble/body, never to the run-order JSON.

| Test | file:line | Pre-change at `b3181b79` |
| --- | --- | --- |
| box-hosted blocks never call `ai_run ai-gates` or open `evidence_root` | `tests/admin-release-plan.test.ts:4553` | FAIL: `ai-w4-apply`, `ai-w6-activation-checks`, `ai-w6-activation-apply` call `ai_run ai-gates` |
| bind passes with no evidence tree; one-byte and other-release refuse; `ai-gates` still needs the tree | `tests/admin-release-plan.test.ts:4569` | helper absent; `ai-gates` on the same receipt prints `FAIL ai-gates: evidence root; STOP` |

Official gate `C1_GATE_EXTRA="tests/c1-task-from-plan.test.ts tests/p1-cli/test-gate-coverage.test.ts" bash /Users/yulanbot/work/c1-verify/build/gate-c1.sh` in this sandbox:

```
mktemp: mkdtemp failed on /tmp/lane-home.iGcQ24: Operation not permitted
```

Equivalent inner run (same files except `tests/c1-w2-rehearsal.test.ts`, which also mktemps `/tmp/c1w2.*`) under `HOME=/private/tmp/cs-c1-frozen/scratchpad/lane-home.XXXXXX`, `env -u NODE_OPTIONS`, `node --import tsx --test` of plan, w123, w45, w6-ready, `c1-task-from-plan`, and `p1-cli/test-gate-coverage`:

```
ℹ tests 198
ℹ suites 0
ℹ pass 197
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 198776.115792
INNER_RC=0
```

Skipped: C1-5 Caddy imports (no `caddy` binary). Two new tests (box call-site pin vs `b3181b79`; extracted bind pass/one-byte/other-release plus unchanged `ai-gates` evidence-root refusal). D-030 still reaches every test file. No commit or push. HEAD remains `b3181b79`. PG rehearsal, Caddy and the Mac sandbox TAP are left for the Lead.

