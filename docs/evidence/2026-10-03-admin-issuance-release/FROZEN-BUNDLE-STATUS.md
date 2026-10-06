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
