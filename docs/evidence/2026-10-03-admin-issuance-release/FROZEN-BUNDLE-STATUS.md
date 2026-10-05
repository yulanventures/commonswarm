# Frozen bundle status (lane/c1-frozen)

Branch `lane/c1-frozen`, from origin/main `a5cb8251`. Owner: CSwarm Lead
subagent. Stop time: 2026-10-04 05:30Z (Tom: all swarm activity stops 06:10Z).
Nothing here is pushed; the coordinator pushes. Commits: `9570c67b` (item 1),
`efd84d82` (rulings), `9e32e3b6` (W4 retry), then this status file.

## Done

| Item | Commit | Tests |
| --- | --- | --- |
| W6 binds an EARLIER W2b: inputs `w2b_release_sha` + `w2b_window_id` (W6 only); ai-w2b-proof-check reads the bound release; new ai-w6-issuer-live re-verifies the credential live (LOGIN with password, file 0440 root:986, TLS login with the installed credential, five forward catalogs true), called from ai-w6-activation-checks | 9570c67b | plan.test (inputs, proof-check at another release), w123 (issuer-live positive + 8 refusals), w6-ready, plan-sandbox inputs, W6 rehearsal inputs |
| W3 same-version retry: ai-release-aside (shared; parent root 0700, same filesystem, one rename, `oauth-aside.json`), ai-w3-rollback rewritten (paths from INPUTS, explicit-fail every step, `ln -sfT`, aside after the baseline is live, `W3-rollback.txt`), ai-w3-preflight refuses a present tree with the exact recovery and records other releases' trees in `oauth-releases-inventory.json`, ai-w3-apply `ln -sfT`, ai-close recovered W3 requires baseline current/image and no tree at this release | 9570c67b | w123 (rollback positive, idempotent rerun, nothing-to-move, 7 refusals x 2 errexit modes, stale-tree evidence, preflight refusal text), plan.test (recovered W3 close: 1 positive + 2 tolerated residues + 4 refusals) |
| Rulings folded as plan text (section "Execution rulings") | efd84d82 | prose only |
| W4 same-version retry: ai-w4-rollback (paths from INPUTS, `ln -sfT`, ai-release-aside with `edge` after current is on the baseline), ai-w4-preflight refusal with the exact recovery, ai-w4-apply `ln -sfT`, ai-close recovered W4 requires baseline edge current, baseline Caddy bytes, no drop-in, no tree | 9e32e3b6 | w45 (leftover temporary link replaced, preflight refusal text), plan.test (recovered W4 close: 2 positives + 5 refusals; rollback order). NOT executed: ai-w4-rollback end to end and ai-release-aside with `edge` (no w45 rollback fixture) |

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
| W4 | `edge/releases/<sha>` tree | Was refused by ai-w4-preflight and never moved | FIXED 9e32e3b6 (rollback moves it aside; recovered close requires it absent; preflight refusal names the recovery). Rollback run end to end is not yet tested (TODO-1) |
| W4 | `edge/current.admin-issuance` link | `ln -s` hazard as W3 | FIXED 9e32e3b6 |
| W4 | Live Caddy files | Rollback restores from SECRET_STAGE; ai-box-preflight byte-checks the baseline hashes at the next open | OK (existing); recovered-close check added 9e32e3b6 |
| W4 | Recycle drop-in | Rollback removes it; ai-recycle-install refuses a present one | OK (existing); recovered-close check added 9e32e3b6 |
| W4 | Hook binary and `recycle.json` | Overwritten by the retry's ai-recycle-install (O_TRUNC, write_text); nothing reads them while the drop-in is absent | OK (deterministic overwrite) |
| W4 | DB: legacy fence, generation +1, invalidated_at | apply_legacy_admin_fence returns early when already closed; apply closes before measuring | OK (idempotent) |
| W4 | Recycle timer stopped | ai-timer-guard re-arms on every exit; ai-close refuses an inactive timer | OK (existing) |
| W5 | Site release dir, Mac W5 root, PREP_DIR | Site releases are timestamped; W5 root and PREP_DIR are per window_id; the site plan owns its rollback | OK |
| W6 | Smoke pointer `/Users/yulanbot/work/dcr-rt/c1-smoke.pointer` (fixed path) | ai-w6-pointer refuses an existing pointer (assert, no recovery text); a recovered W6 close does not require ai-w6-secret-close | TODO-2 |
| W6 | C1 verification row at version v | Identical row accepted | OK |
| W6 | Owner approval at v, withdrawn by the failed W6 | `approve_admin_client` is refused (`client_approval_withdrawn`, protocol.js:1634); a new version v+1 is refused while v is active ("another active C1 verification version"). W6 is NOT retryable after an approve+withdraw | TODO-3 (real defect) |
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

## Not done (exact next step per item)

- **TODO-1 W4 rollback execution test.** The plan change is in 9e32e3b6. Next
  step: a w45 fixture that runs ai-w4-rollback end to end (stubs for
  `ai_run ai-timer-guard` / `ai-recycle-rollback` / `ai-release-aside`, docker
  compose on OLD_EDGE, `readlink -f`, `install -d`, `stat` on
  `edge/failed-attempts`), with the modelled ignored-errexit mode as in the W3
  test. The other W4 rollback lines are still `set -e` only (no explicit
  `|| { FAIL }`); convert them in the same change.
- **TODO-2 W6 pointer.** ai-w6-pointer: replace the bare assert with
  `FAIL ai-w6-pointer: smoke pointer expected absent got present; an earlier W6
  left it: run ai-w6-secret-close with that window's C1_PROOF_DIR, then retry;
  STOP`. ai-close recovered W6: if `C1-client-check.txt` exists in PROOF_DIR,
  require the uploaded `C1-cleanup.txt`.
- **TODO-3 W6 C1 version retry.** In ai-w6-client-verification's DO block: if
  the active version u differs from v AND this owner's approval at u is
  withdrawn, `UPDATE ... SET active=false, withdrawn_at=statement_timestamp(),
  withdrawal_reason='c1-retry-superseded'` for u (the guard permits exactly
  these three columns) and insert v; if u = v and the owner's approval at v is
  withdrawn, refuse naming the next version; keep the other refusals (the
  rehearsal case `second-active-version`, no approval, still refuses). Add a
  rehearsal positive with a seeded withdrawn approval
  (`SET session_replication_role=replica` for the seed). Residual gap to list:
  the guard's `fence_admin_family(...,'suspended')` on already-revoked bindings
  is not exercised.
- **Generator `scripts/c1-task-from-plan.mjs`** (item 3) and
  **VERIFY-HARNESS.md** (item 4): not started (Tom's priority order puts them
  last).
