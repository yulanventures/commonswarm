# Frozen bundle status (lane/c1-frozen-work)

Branch `lane/c1-frozen-work`, based on origin/main `a5cb8251`. HezLead owns
review and integration. Committed HEAD is `03c3c9d4`: C1-1 TODO repairs are in `1c5d4dbc`, the
generator/run orders in `edf4a3bf`, C1-4 checker/ruling repairs in `69fa19f7`,
and the first W4 Caddy production-defect repair in `03c3c9d4`.
C1-6 below is an uncommitted patch on that exact base. This worker does not
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
`scratchpad/c1-6-gate-final.exit`. This measures the uncommitted C1-6 patch,
not CI or production. The first C1-6 gate was 168/169, exit 1: the new generator
test expected three selected companion failure-table rows to be adjacent.
It now verifies each row verbatim against the companion; generator 7/7 and
then the full required gate passed. First log: `scratchpad/c1-6-gate.log`.
`bash -n` passed all 87 marked blocks; `git diff --check` passed.
No full suite, build, Docker, browser, commit, push or production operation ran.

## Handoff

HezLead owns the cross-family check and integration. C1-6 makes no commit,
push or production change. `VERIFY-HARNESS.md` stays outside this assignment.
