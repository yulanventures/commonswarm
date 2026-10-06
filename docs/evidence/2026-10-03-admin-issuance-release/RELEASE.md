# Admin issuance release: W2–W7

Prepared, not executed. This plan releases one reviewed `RELEASE_SHA`, landed on
main, in seven separately authorized windows, plus the issuer-only W2b window
when W2 committed the schema but not the issuer credential. The preparation worker has made
no box measurements. Neither this document nor a PASS receipt grants approval.
Admin issuance remains OFF until HezLead executes W6 after a fresh browser-readiness marker: the reviewed issuer
coordinator, activation-only overlay, exact `MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1`,
open DB cutover and independently measured release are all required.

Authority: the admin issuance specification's boundaries, lane 8, findings and
D1–D9 decisions and HezLead’s W1–W7 sequencing; `deploy/RELEASE-TO-BOX.md`; the generalized October 2 OAuth,
edge, site and DCR plans. The implementation timestamps are M1–M5 =
20261003000001–05; the fifth also supplies recovery. D2 is sometimes called M4 in code;
it is **not** the deferred delegation migration.

Execute ONLY whole marked blocks by ID. Each block has a readonly marker; probe
means a bounded HTTP request can write admission/security bookkeeping. Use one
root Bash shell per box window and one Mac `/bin/bash` 3.2 shell for preparation.
Never author commands inside a release window. No automatic retries, Actions,
GUI apps, installed Chrome, real Chrome profiles, keychain, or HOME assignments.
W6's human consent is performed by HezLead's separately assigned browser worker;
this plan itself launches no browser. Credentials use existing protected files.
Any separately assigned 1Password recovery must load its service-account token
file for that command only and stage secrets in a new 0700
`mktemp -d /private/tmp/anvil-secret.XXXXXX` directory. No desktop op session.

Image builds: build once per RELEASE_SHA, reuse the persistent local SHA tag
only after checking the source label. `DOCKER_BUILDKIT=0 nice -n 15` plus
`--cpu-period=100000 --cpu-quota=300000` caps sequential build steps at three
CPUs. Unsupported caps or a mismatched tag STOP. Edge uses its measured pinned
runtime image; site builds on the Mac. Never rebuild for each window.

## Inputs, measurements, receipts and window order

`INPUTS_FILE` is an absolute regular nonsecret JSON file, supplied by HezLead.
Use a **new** file/measurement/window ID for each window. Required keys are
enforced by `ai-inputs`; extra/missing keys STOP. It contains:

Production window_ids never start with /^stg/i (any case); producers redraw such an id. STG + 3 alphanumerics is reserved for disposable staging boxes carrying the staging marker.

The staging marker is `/etc/commonswarm-release/STAGING-ONLY`, a regular,
non-symlink file owned root:root with mode 0600 and exactly the 35 ASCII bytes
`c1-staging-disposable-no-production` (no trailing newline). Only disposable
staging producers outside this repository create it; no release block creates
or repairs it. ai-inputs reads it before other validation on the box: an absent
marker refuses /^stg/i; a valid marker requires ^STG[A-Za-z0-9]{3}$; a malformed
or unreadable marker always refuses, including for a production-shaped id.

On the Mac, ordinary ids require no marker evidence. An /^stg/i id requires
^STG[A-Za-z0-9]{3}$ and the window's existing sibling box measurement file,
`measurements-baselines-<window>.json` beside INPUTS_FILE. Its existing
`baselines` and `measured_at_utc` retain their meanings; the measurement must
match every baseline it reports against INPUTS, be at most 300 seconds old
and not in the future. The staging producer retains `release_sha`, `window`,
`window_id` and `inputs_sha256` (the digest of the exact INPUTS_FILE bytes),
and a `staging_marker` measurement with exactly `path`, `regular`, `symlink`,
`uid`, `gid`, `mode`, `content`: the marker path above, true, false, 0, 0,
`0600`, and the exact content above. Missing, mismatched or malformed evidence
refuses STG. These are box-evidence fields, never new INPUTS keys. The Mac
never requires STG; its own filesystem cannot authorize a staging id.

| Input | Source and validation |
| --- | --- |
| release_sha, plan_sha256, archive_sha256 | Reviewed landed main commit; SHA-256 of this exact RELEASE.md and exact `git archive` tar; no abbreviated identities |
| window, window_id, window_end_utc | W1…W7 or W2b, six alphanumeric characters, UTC end within 30 minutes on box clock (W6: within 90 minutes, HezLead ruling; beyond its end only ai-emergency-close and a recovered close remain) |
| baseline_oauth_sha, baseline_oauth_image | Live OAuth `current`/RELEASE_SHA + container source/image measurement; full SHA/digest |
| baseline_edge_sha, baseline_edge_image | Live edge `current`/RELEASE_SHA, image and immutable bind mounts |
| baseline_stack_sha, baseline_postgres_image | Live stack `current`/RELEASE_SHA and PostgreSQL container image |
| baseline_site_sha, baseline_site_target | Exact source from box site release-name prefix resolved uniquely against repository history; canonical release target |
| baseline_mcp_caddy_sha256, baseline_api_caddy_sha256, baseline_caddyfile_sha256 | SHA-256 of the three live Caddy files; compare on box, never assume repository bytes are live |
| edge_recycle_service, edge_recycle_timer, edge_recycle_sha256 | Exact recycle units discovered from box timer/service inventory and systemctl cat byte digest, remeasured per window |
| baseline_ledger_sha256 | SHA-256 of sorted version lines from live migration ledger, including final newline |
| gate_receipt_sha256 | Independent checker's receipt digest; see GATES.json; exact combined build, no stale lane receipts |
| rollback_decision | `retain-additive` W1–W2 and W2b; `restore-service` W3–W5; `close-and-reconcile` W6–W7 |
| approval | `null` W1–W5; W6/W7 explicit Tom/HezLead approval object tied to window ID, release, plan digest, action and a nonempty prompt reference; W6 authorizes activation and assigned human consent |
| legacy_fence_approval | `null` except W4, which requires separate explicit approval of irreversible legacy DB closure with the same release/window/plan binding |
| probe_workspace_id | W2 only (absent in every other window): the UUID of HezLead's authorized ordinary smoke workspace that the W2 probe credentials must name |
| w2_release_sha, w2_window_id | W2b only (required there, absent in every other window): the full RELEASE_SHA and window ID of the W2 that committed the schema. W2 may have run at an earlier release (W2 RGLqZX ran at 5f64fab4); its proof directory is bound by these two fields, not by RELEASE_SHA |
| w6_window_id | W7 only, REQUIRED there: the window ID of the W6 of this release that closed success. W7 reads that W6's C1.json and close-result.json from its box proof directory and measures the digest itself |
| w2b_release_sha, w2b_window_id | W6 only, REQUIRED there (absent in every other window): the full RELEASE_SHA and window ID of the W2b that provisioned the issuer credential. W2b may have run at an EARLIER release (W2b yYGHEd ran at a5cb8251; W2b cannot run again once the issuer has LOGIN), exactly as W2b binds W2. W6 activation checks refuse unless that W2b closed success with w2b-preconditions.txt, issuer-credential.txt and w2b-forward-catalogs.txt (validated against THAT release's archive and inputs), and ai-w6-issuer-live re-verifies the credential live: role LOGIN with a password, the installed file 0440 root:986, a TLS login as the issuer with the installed credential, and all five forward catalogs true |

`PLAN_FILE`, `INPUTS_FILE`, `GATE_RECEIPT_FILE` are absolute regular files.
Every block that extracts and runs plan text (ai-extract, ai_run, the ai-edge-receipt
and ai-live-controls runners, ai-recycle-install) reads the plan once as bytes,
refuses a symlink or non-regular file and any sha256 other than INPUTS
plan_sha256, and extracts only from those verified bytes;
`BOX_ARCHIVE_PATH=/tmp/admin-issuance-<release_sha>-<window_id>.tar` is an
uploaded 0600 tar, exact checksum, never overwritten. `RELEASE_ROOT` and
`PROOF_DIR` are derived at open, not caller-selected. `LIVE_CONTROLS_FILE`
(per window and phase) and `CONSENT_RECEIPT_FILE` (per release: `pre-W1` or
`post-W5`) are absolute regular nonsecret JSON files from the dedicated
controls worker; ai-open and ai-live-controls enforce their exact schema,
release/window binding, consent digest and producer digest. `GATE_RECEIPT_FILE`
contains release_sha, gates, and evidence_root; each gate names a relative
evidence file, its SHA-256, PASS and the exact control set in GATES.json.
The checker supplies the receipt and retained evidence files. This plan checks
their identities and controls; it does not substitute static checks for live
database/provider/client proofs. The checker must refute the combined build.
W1 needs backup/restore controls; W2 needs schema, reserve and ordinary-path controls; W6 needs **every** named
gate. W3/W4/W5 also require their build/route/site receipts.

`BACKFILL_FILE` W2 is an absolute regular nonsecret JSON list, exactly one row
per already-applied ledger version, and every row names its `evidence_kind`.
`file` is always exactly `supabase/migrations/<version>_<name>.sql`. Nobody
invents a released_sha. ai-w2-backfill refuses unknown kinds, duplicate rows,
missing ledger versions and rows for versions that are not in the ledger, and
retains each version's kind and the count per kind in `backfill-evidence.json`.

| evidence_kind | Exact row keys | What ai-w2-backfill re-derives |
| --- | --- | --- |
| `release-record` | version, evidence_kind, released_sha, sha256, file | Today's rule, unchanged: released_sha is the SHA actually released when the migration was applied, supported by HezLead's historical release evidence. The file in the immutable `<released_sha>.tar` hashes to sha256 and equals the current file (drift STOPs). |
| `ledger-statements` | version, evidence_kind, file, matched_sha, sha256 | The ledger's own recorded `statements` for the version are non-empty. matched_sha must equal RELEASE_SHA; the file is read from the verified release archive, hashes to sha256, and is an ordered verbatim cover of the recorded statements (below). matched_sha names the commit whose file covers what the ledger recorded; it is not a released_sha. |
| `attested-baseline` | version, evidence_kind, file, sha256, attested_by, attested_at, reason (optional pointer, written_by) | The ledger statements for the version are NULL or empty (non-empty STOPs: the row must be `ledger-statements`). The file in the verified release archive hashes to sha256. attested_by is exactly `HezLead`, attested_at is a UTC Z time not in the future, and reason is HezLead's own non-empty single-line text (at most 2000 characters, no control characters), retained verbatim. For every such row the plan prints its own fixed meaning line: "attested-baseline: no release record and no recorded statements; file bytes at RELEASE_SHA adopted as UNVERIFIED drift baseline". That line is the ONLY meaning of an attested-baseline row; it never proves that the applied SQL equals the file. Isolation (HezLead 2026-10-06): on a box without `/etc/commonswarm-release/STAGING-ONLY` (same marker logic as STG reservation), refuse any attestation whose pointer, reason or written_by contains `c1-staging`, and require the 20260916000001/20260916000002 rows to match the pinned 2026-10-04 production attestation canonical sha256 `b17a55e8c078945af8df0c56dcb272682d1e22fb7318b529a633cf9468d70031`. On a box with that marker, require pointer to start with `c1-staging/`. Every present pointer, written_by, reason, attested_by or attested_at field must be a string before those checks; a list or object is refused. |

Ordered verbatim cover (`verbatim_cover` in ai-w2-backfill; no comment
stripping and no normalization): every recorded statement is a non-empty string
that appears byte-for-byte in the file, in ledger order and without overlap, and
the text before the first, between any two and after the last consists only of
whitespace and semicolons. A reordered, changed, missing or extra statement, or
a comment or any other text in a gap, STOPs.

`migration_checksums` keeps exactly its current meaning and shape (no
migration changes): source `backfill` and the sha256 of the file bytes at
RELEASE_SHA for every already-applied version, which is what drift detection
needs. Its released_sha column holds the row's released_sha for
`release-record` rows and RELEASE_SHA (the commit whose bytes are recorded, as
for the M1–M3 backfills) for `ledger-statements` and `attested-baseline` rows.
The provenance itself is W2 release evidence: ai-w2-backfill retains
`backfill-evidence.json` (each version's kind with its release-record fields,
cover result or attestation, plus per-kind counts) and prints its sha256 in its
PASS line.
Do not hash the current checkout for historical backfills, or copy expected
activation hashes into observed evidence. Expected activation hashes are
separately derived from RELEASE_SHA. A mismatch STOPs activation.

| Window | Preflight → open → apply → probes → close; rollback chosen before open |
| --- | --- |
| W1 BACKUP GATE | common preflight/open/session; ai-w1-backup-gate (shared with W2b and W4) verifies the fresh backup and restore receipt, ordinary probes/live controls, ai-close. HezLead takes the backup before this window; this plan never starts backup or restore services. |
| W2 SCHEMA | common preflight/open/session; ai-w2-stage-probes (Mac), ai-w2-preflight (includes ai-w2-measure), ai-w2-apply (pre-fence probe, five separate transactions, probes after each, DCR probe grant revoke), ai-w2-reconcile, ai-w2-probes, issuer credential, ordinary controls, ai-close. Failure: STOP, reconcile the committed prefix, retain it; no retry or automatic reserve. |
| W2b ISSUER | Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back. common preflight/open/session (ordinary probes before; ai-open validates the live controls and pre-W1 consent receipt itself; standalone ai-live-controls only after open); ai-w1-backup-gate (fresh backup, as W1); ai-w2b-preflight (bound W2 proof, ledger, NOLOGIN role without password, credential file absent); ai-w2-issuer-credential; ai-w2b-forward-catalogs (all five forward catalogs true, unmodified; a false one runs ai-w2-issuer-rollback and STOPs); ordinary probes, ai-live-controls after, ai-close. No DCR probe grant and no backfill. Failure: ai-w2-issuer-rollback, then recovered close. The order is W2b, W3, then W4, W5, W6, W7; nothing in W2b or in the W6 binding assumes which window ran just before or after it. |
| W3 OAUTH | common preflight/open/session; ai-w3-preflight, ai-w3-build, ai-w3-apply, ai-w3-local-gate, ordinary controls, ai-close. Overlay absent, admin env unset, gate CLOSED. On failure ai-w3-rollback. |
| W4 EDGE/CADDY | common preflight/open/session; ai-w1-backup-gate (fresh backup, as W1); ai-w4-preflight, ai-w4-caddy-candidate, ai-w4-apply, ai-w4-probes, ai-w4-readback, ordinary controls, ai-close. Includes /admin, GET/HEAD /admin/gate and recycle drop-in; terminal legacy fence needs its own approval. On failure ai-w4-rollback. Its EXIT guard restores/verifies the recycle timer on every outcome. |
| W5 SITE | ai-w5-preflight (runs ai-live-controls phase before with the pre-W1 consent receipt), ai-w5-reference in the generalized site plan’s normal order, including its browser ownership close; ai-w5-closed runs ai-live-controls phase after with the post-W5 consent receipt, then records verified site close and GET/HEAD /admin/gate CLOSED. Publishes CIMD client document and callback page. W1–W5 may run before browser consent is ready. |
| W6 ACTIVATION + C1 | ai-w6-c1-inputs (Mac producer), ai-w6-preflight (readiness + activation/consent approval); ai-edge-refresh first if the edge receipt is stale; common preflight/open/session; ai-w6-prepare and upload C1-inputs.json; ai-w6-activation-checks (includes the retained recycle archive); ai-w6-client-document, ai-w6-client-verification (reviewed C1 row, issuance still CLOSED); ai-w6-activation-apply (shared remeasure; recycle timer HELD until finish), probes, readback; ai-w6-client-check, download C1-client-check.txt; ai-w6-start, ai-w6-pointer; owner approve immediately before consent; Mac ai-w6-fence-driver (agent receipt, upload, dispatch ai-w6-audit to the existing box root shell only after agent.json exists, download, human revoke inside the 240 s fence); agent receipt again, owner withdrawal, upload client-withdraw.json and agent-final.json, fence readback, ai-w6-finish (both paths remeasure into edge-measurement-final.json and re-arm the timer), secret-close, report, ordinary controls, ai-close. Default removes env/overlay and closes cutover, then probes CLOSED; an explicit bound keep-open input retains OPEN (HezLead ruling at this release: keep open). W6 may last 90 minutes. Failure stops forward work; withdraw/revoke any committed grant, ai-emergency-close (re-arms the timer) before the recovered close; every close STOPs while the timer is inactive. |
| W7 RETIRE | ai-w7-approval; EDGE_MEASUREMENT_FILE = W6's edge-measurement-final.json, or ai-edge-refresh first if a recycle made it stale; common preflight/open/session, ai-w7-preflight (the W6 named by w6_window_id closed success with an exact C1 report), ai-w7-proof, ordinary controls, ai-close. Retirement proof is unchanged and works with issuance OPEN (keep-open) or CLOSED; never restore opaque authentication. |

Each JSON line is one ordered block, an exact `manual:` source passage, or
an explicit conditional or manual operation. `host` is `mac` (persistent M) or
`box` (persistent B). `when:` quotes start at their stated 1-based plan line;
input notes are required caller inputs, never shell commands. Conditions are
literal plan text, not executable expressions. Failure-only entries are branches:
a failed open aborts and stops forward work. Rollback orders stop before close;
recovered-close orders include recovery and the sole closer. W6e is the W6
emergency-close entry point, using W6 inputs, never a new window value.
The eight C1-3 ambiguities use HezLead's C1-4 rulings. Each window/mode has one order.
Tasks are review artifacts and execute no commands.
Nested helpers execute through their existing callers and are not dispatched twice.
W5 delegates the pinned companion bytes at the same RELEASE_SHA (F), starting
with site-release-shared-preflight and retaining every companion gate.

## Run orders (machine-read by scripts/c1-task-from-plan.mjs)

site-plan: {"path":"docs/evidence/2026-10-02-site-release/SITE-RELEASE.md","sha256":"37bfd2779ec7994ca25353e2f10bc0c6e59969add6a4589cb765caa3407a147b"}

```c1-order W1 forward
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w1-backup-gate","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W1 rollback
{"host":"box","manual":{"line":75,"quote":"`retain-additive` W1\u2013W2 and W2b;"}}
```

```c1-order W1 recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"host":"box","manual":{"line":75,"quote":"`retain-additive` W1\u2013W2 and W2b;"}}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W2 forward
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box","input":"W2 refuses before mkdir if all five 20261003 versions are already present"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w2-stage-probes","host":"mac"}
{"id":"ai-w2-preflight","host":"box","input":"BACKFILL_FILE; HISTORICAL_ARCHIVES_DIR; W1_CLOSED_FILE: the fresh W1 close"}
{"id":"ai-w2-apply","host":"box","when":{"line":659,"quote":"5. **W2 apply-time gate.** ai-w2-apply starts only when `window_end_utc - now\n   >= 600 s` on the box clock; otherwise STOP before the fence and close\n   pre-fence. No deadline check runs after the fence."}}
{"id":"ai-w2-reconcile","host":"box"}
{"id":"ai-w2-probes","host":"box"}
{"id":"ai-w2-issuer-credential","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W2 rollback
{"host":"box","manual":{"line":140,"quote":"Failure: STOP, reconcile the committed prefix, retain it; no retry or automatic reserve."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w2-reconcile","host":"box","when":{"line":2021,"quote":"Mid-sequence failure: STOP; committed migrations and ledger rows stay. After\nM4 their exact checksum/backfill rows stay too. Issuance remains OFF. A durable\napply-started marker refuses ALL reruns, including a failure before M1."},"input":"Only after apply-started.txt; read-only reconciliation. An incomplete prefix records schema-prefix.json then STOPs: retain it, do not continue this order. No apply, retry or reserve."}
{"id":"ai-w2-issuer-rollback","host":"box","when":{"line":3045,"quote":"Rollback disables login and clears the new password; it retains additive schema."},"input":"Only when this window wrote issuer-provisioning-attempted.txt before mutation; otherwise refuse and leave the live issuer; no schema rollback"}
{"host":"box","manual":{"line":2030,"quote":"No automatic or\npost-COMMIT production schema rollback is authorized."}}
```

```c1-order W2 recovered-close
{"host":"box","manual":{"line":140,"quote":"Failure: STOP, reconcile the committed prefix, retain it; no retry or automatic reserve."}}
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w2-reconcile","host":"box","when":{"line":2021,"quote":"Mid-sequence failure: STOP; committed migrations and ledger rows stay. After\nM4 their exact checksum/backfill rows stay too. Issuance remains OFF. A durable\napply-started marker refuses ALL reruns, including a failure before M1."},"input":"Only after apply-started.txt; read-only reconciliation. An incomplete prefix records schema-prefix.json then STOPs: retain it, do not continue this order. No apply, retry or reserve."}
{"id":"ai-w2-issuer-rollback","host":"box","when":{"line":3073,"quote":"# Ownership marker BEFORE any mutation: rollback and recovered close consult this file."},"input":"Only when this window wrote issuer-provisioning-attempted.txt before mutation; otherwise refuse and leave the live issuer; pre-fence/pre-mutation recovery omits it and closes on the captured ledger baseline"}
{"host":"box","manual":{"line":2030,"quote":"No automatic or\npost-COMMIT production schema rollback is authorized."}}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; pre-fence: unchanged ledger-at-open, no issuer-rollback; issuer wipe only if this window wrote issuer-provisioning-attempted.txt"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W2b forward
{"id":"ai-inputs","host":"mac","when":{"line":141,"quote":"Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back."}}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w1-backup-gate","host":"box"}
{"id":"ai-w2b-preflight","host":"box"}
{"id":"ai-w2-issuer-credential","host":"box"}
{"id":"ai-w2b-forward-catalogs","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W2b rollback
{"host":"box","manual":{"line":141,"quote":"Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back."},"when":{"line":141,"quote":"Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w2-issuer-rollback","host":"box","when":{"line":3205,"quote":"ai-w2-issuer-rollback and a recovered close."},"input":"Only when this window wrote issuer-provisioning-attempted.txt before mutation; otherwise refuse and leave the live issuer"}
```

```c1-order W2b recovered-close
{"host":"box","manual":{"line":141,"quote":"Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back."},"when":{"line":141,"quote":"Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back."}}
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w2-issuer-rollback","host":"box","when":{"line":3073,"quote":"# Ownership marker BEFORE any mutation: rollback and recovered close consult this file."},"input":"Only when this window wrote issuer-provisioning-attempted.txt before mutation; otherwise refuse and leave the live issuer"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; issuer wipe only if this window wrote issuer-provisioning-attempted.txt"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W3 forward
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w3-preflight","host":"box"}
{"id":"ai-w3-build","host":"box"}
{"id":"ai-w3-apply","host":"box"}
{"id":"ai-w3-local-gate","host":"box"}
{"id":"ai-w3-probes","host":"mac","when":{"line":3547,"quote":"ai-w3-probes only if baseline Caddy already serves that route; W4 makes it\nmandatory with CORS. Baseline route availability is measured, never guessed."}}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W3 rollback
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w3-rollback","host":"box"}
```

```c1-order W3 recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w3-rollback","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W4 forward
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w1-backup-gate","host":"box"}
{"id":"ai-w4-preflight","host":"box"}
{"id":"ai-w4-caddy-candidate","host":"box"}
{"id":"ai-w4-apply","host":"box"}
{"id":"ai-w4-probes","host":"mac"}
{"id":"ai-w4-readback","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W4 rollback
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w4-rollback","host":"box"}
{"id":"ai-w4-timer-recovery","host":"box","input":"Only after timer recovery failure; retains no close claim","when":{"line":4060,"quote":"# host: box root; also available after a failed rollback; not a close receipt"}}
```

```c1-order W4 recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w4-rollback","host":"box"}
{"id":"ai-w4-timer-recovery","host":"box","input":"Only after timer recovery failure; retains no close claim","when":{"line":4060,"quote":"# host: box root; also available after a failed rollback; not a close receipt"}}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W5 forward
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-edge-refresh","host":"box","input":"Only stale receipt; new EDGE_MEASUREMENT_OUT; replace EDGE_MEASUREMENT_FILE with successful fresh receipt","when":{"line":1045,"quote":"ai-close. Before a W5/W6/W7 open whose receipt is stale, HezLead runs\n`ai-edge-refresh`, which owns the timer for that step only and always re-arms it."}}
{"id":"ai-w5-preflight","host":"mac"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site-release-shared-preflight; first companion step"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-plan-inputs"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-00-source-checkout"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-01"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-00-a-close-ingest"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-00-build-env"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-02"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-03-browser-session-preflight"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-03"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-03-pin-previous"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-03-go-record"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-04"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-05"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-05-browser-acceptance"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-06"}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-07-manifest-close"}
{"id":"ai-w5-closed","host":"mac"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W5 rollback
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-04-reconcile-failure; only once after failed/disconnected site2-04","when":{"line":4647,"quote":"| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-06","when":{"line":4646,"quote":"| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` verifies baseline unchanged and closes without a pin. |\n| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |\n| `site2-05` or blocking `site2-05-browser-acceptance` fails | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-07-pre-pin-manifest-close; only failure before pin invocation","when":{"line":4646,"quote":"| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` verifies baseline unchanged and closes without a pin. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-07-manifest-close; only reconciled deployment/public/browser failure","when":{"line":4647,"quote":"| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |\n| `site2-05` or blocking `site2-05-browser-acceptance` fails | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |"}}
```

```c1-order W5 recovered-close
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-04-reconcile-failure; only once after failed/disconnected site2-04","when":{"line":4647,"quote":"| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-06","when":{"line":4646,"quote":"| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` verifies baseline unchanged and closes without a pin. |\n| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |\n| `site2-05` or blocking `site2-05-browser-acceptance` fails | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-07-pre-pin-manifest-close; only failure before pin invocation","when":{"line":4646,"quote":"| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` verifies baseline unchanged and closes without a pin. |"}}
{"id":"ai-w5-reference","host":"mac","input":"SITE_STEP=site2-07-manifest-close; only reconciled deployment/public/browser failure","when":{"line":4647,"quote":"| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |\n| `site2-05` or blocking `site2-05-browser-acceptance` fails | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |"}}
{"id":"ai-ordinary-probes","host":"mac","input":"Recovery receipt and matching post-W5 consent receipt","when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
{"id":"ai-w5-recovery-transfer","host":"mac","when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
{"id":"ai-w5-recovery-env","host":"box","input":"Fresh persistent box root shell; derive WINDOW/PROOF_DIR/INPUTS_FILE/BOX_ARCHIVE_PATH/SITE_RECOVERY_EVIDENCE/PLAN_FILE/CLOSE_RESULT from transferred inputs; never ai-open or ai-db-session","when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; W5 nonsecret proof paths from recovery transfer; SITE_RECOVERY_EVIDENCE=$PROOF_DIR/site-recovery","when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."},"when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
{"id":"ai-mac-close","host":"mac","when":{"line":4650,"quote":"W5 C1 recovered close runs only after site2-07-manifest-close has recorded\nCLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released\nthe pin, and completed cleanup; GO and partial-pin failures stay open."}}
```

```c1-order W6 forward
{"id":"ai-w6-activation-approval","host":"mac"}
{"host":"mac","manual":{"line":5457,"quote":"- **BROWSER-READY** (`/Users/yulanbot/work/BROWSER-READY`, Mac). Producer: HezLead\n  on Tom's unlocked Mac, by `touch` AFTER the W5 close at this release and\n  shortly before the W6 open. Contract: a regular non-symlink file; only its\n  modification time matters (newer than the W5 `closed.txt` time and not in the\n  future: ai-w6-readiness, ai-w6-preflight, ai-open). Content is ignored. A file\n  touched before the W5 close STOPs W6; touch it again after the close."}}
{"id":"ai-w6-c1-inputs","host":"mac"}
{"id":"ai-w6-preflight","host":"mac"}
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-w6-readiness-transfer","host":"mac"}
{"id":"ai-edge-receipt","host":"box","input":"EDGE_MEASUREMENT_FILE=W4 edge-measurement.json; INPUTS_FILE exported or passed to every child"}
{"id":"ai-edge-refresh","host":"box","input":"Only stale receipt; new output; use fresh receipt","when":{"line":1045,"quote":"ai-close. Before a W5/W6/W7 open whose receipt is stale, HezLead runs\n`ai-edge-refresh`, which owns the timer for that step only and always re-arms it."}}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w6-prepare","host":"mac"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-inputs.json; box C1_INPUTS_FILE=$PROOF_DIR/C1-inputs.json"}
{"id":"ai-w6-activation-checks","host":"box"}
{"id":"ai-w6-client-document","host":"box"}
{"id":"ai-w6-client-verification","host":"box"}
{"id":"ai-w6-readiness","host":"box"}
{"id":"ai-w6-activation-apply","host":"box"}
{"id":"ai-w6-activation-probes","host":"mac"}
{"id":"ai-w6-activation-readback","host":"box"}
{"id":"ai-w6-client-check","host":"box"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=download; C1_TRANSFER_FILE=C1-client-check.txt"}
{"id":"ai-w6-start","host":"mac"}
{"id":"ai-w6-pointer","host":"mac"}
{"id":"ai-w6-secret-close","host":"mac","input":"Operator-directed only after a stale-pointer refusal: Earlier window's C1_PROOF_DIR; only stopped runner; do not remove another window's pointer by hand"}
{"id":"ai-w6-pointer","host":"mac","input":"Operator-directed only after a stale-pointer refusal: Current window after prior-window cleanup; restore current variables"}
{"id":"ai-w6-owner-client-command","host":"mac","input":"C1_CLIENT_ACTION=approve; immediately before separately assigned consent"}
{"host":"mac","manual":{"line":5883,"quote":"HezLead's browser worker reads the pointer, waits for the 0600 authorize file,\nrefuses an expired pointer, follows consent_choices exactly (granular: workspace, scopes and home=false, full_account=false),\nthen atomically writes the full callback URL as 0600 to\nthe secret callback path without logging it. This is a separate browser-worker\nassignment; this plan never launches the installed Chrome app. HezLead starts"}}
{"id":"ai-w6-fence-driver","host":"mac","input":"Start concurrently with the separate consent worker on Mac; owns agent receipt/upload, audit dispatch into existing B stdin, audit download and normal human revoke; no other owner-session caller","dispatches":["ai-w6-audit"]}
{"host":"box","manual":{"line":6022,"quote":"# Dispatch only after upload completed; B runs once and never polls for its input."}}
{"id":"ai-w6-agent-receipt","host":"mac"}
{"id":"ai-w6-owner-client-command","host":"mac","input":"C1_CLIENT_ACTION=withdraw; after runner exits"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=client-withdraw.json"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=agent-final.json"}
{"id":"ai-w6-fence-readback","host":"box"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=download; C1_TRANSFER_FILE=C1-fence.txt"}
{"id":"ai-w6-finish","host":"box","input":"Explicit bound keep_open input controls branch; final measurement for W7; timer rearmed on exit"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=download; C1_TRANSFER_FILE=C1-finish.json"}
{"id":"ai-w6-secret-close","host":"mac"}
{"id":"ai-w6-report","host":"mac"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1.json"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-cleanup.txt"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W6 rollback
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-emergency-close","host":"box"}
{"id":"ai-w6-human-revoke","host":"mac","input":"Only committed grant needing recovery; C1_RECOVERY_REVOKE=1; obtain run-specific C1-audit.json first; saved request ID must be reconciled after unknown outcome; cleanup never C1 proof","when":{"line":669,"quote":"7. **Missed fence.** If the W6 fence driver misses its cutoff (the normal\n   human revoke is refused after the cutoff), the close is pre-decided:\n   ai-emergency-close, then the recovery revoke (`C1_RECOVERY_REVOKE=1`,\n   recorded as `human-revoke-recovery.json`, never as C1 refusal proof), then\n   the owner withdraw, then a recovered close, then report STOP. Keep-open is"}}
{"id":"ai-w6-owner-client-command","host":"mac","input":"C1_CLIENT_ACTION=withdraw; only existing approval; after recovery revoke"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=client-withdraw.json; only produced receipt"}
{"id":"ai-w6-secret-close","host":"mac","input":"Only if runner/stage exist and runner has stopped","when":{"line":6281,"quote":"# host: HezLead Mac; success or stopped runner, guarded private cleanup"}}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-cleanup.txt; only produced cleanup receipt"}
```

```c1-order W6 recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-emergency-close","host":"box"}
{"id":"ai-w6-human-revoke","host":"mac","input":"Only committed grant needing recovery; C1_RECOVERY_REVOKE=1; obtain run-specific C1-audit.json first; saved request ID must be reconciled after unknown outcome; cleanup never C1 proof","when":{"line":669,"quote":"7. **Missed fence.** If the W6 fence driver misses its cutoff (the normal\n   human revoke is refused after the cutoff), the close is pre-decided:\n   ai-emergency-close, then the recovery revoke (`C1_RECOVERY_REVOKE=1`,\n   recorded as `human-revoke-recovery.json`, never as C1 refusal proof), then\n   the owner withdraw, then a recovered close, then report STOP. Keep-open is"}}
{"id":"ai-w6-owner-client-command","host":"mac","input":"C1_CLIENT_ACTION=withdraw; only existing approval; after recovery revoke"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=client-withdraw.json; only produced receipt"}
{"id":"ai-w6-secret-close","host":"mac","input":"Only if runner/stage exist and runner has stopped","when":{"line":6281,"quote":"# host: HezLead Mac; success or stopped runner, guarded private cleanup"}}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-cleanup.txt; only produced cleanup receipt"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-w6-close-state","host":"mac","input":"Retained C1_PROOF_DIR from this window; measures secret-stage.path, never the box stage marker; runner stopped"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-close-state.json"}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W6e forward
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-emergency-close","host":"box"}
```

```c1-order W6e rollback
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-emergency-close","host":"box"}
```

```c1-order W6e recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-emergency-close","host":"box"}
{"id":"ai-w6-human-revoke","host":"mac","input":"Only committed grant needing recovery; C1_RECOVERY_REVOKE=1; obtain run-specific C1-audit.json first; saved request ID must be reconciled after unknown outcome; cleanup never C1 proof","when":{"line":669,"quote":"7. **Missed fence.** If the W6 fence driver misses its cutoff (the normal\n   human revoke is refused after the cutoff), the close is pre-decided:\n   ai-emergency-close, then the recovery revoke (`C1_RECOVERY_REVOKE=1`,\n   recorded as `human-revoke-recovery.json`, never as C1 refusal proof), then\n   the owner withdraw, then a recovered close, then report STOP. Keep-open is"}}
{"id":"ai-w6-owner-client-command","host":"mac","input":"C1_CLIENT_ACTION=withdraw; only existing approval; after recovery revoke"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=client-withdraw.json; only produced receipt"}
{"id":"ai-w6-secret-close","host":"mac","input":"Only if runner/stage exist and runner has stopped","when":{"line":6281,"quote":"# host: HezLead Mac; success or stopped runner, guarded private cleanup"}}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-cleanup.txt; only produced cleanup receipt"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-w6-close-state","host":"mac","input":"Retained C1_PROOF_DIR from this window; measures secret-stage.path, never the box stage marker; runner stopped"}
{"id":"ai-w6-transfer","host":"mac","input":"C1_TRANSFER_DIRECTION=upload; C1_TRANSFER_FILE=C1-close-state.json"}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W7 forward
{"id":"ai-w7-approval","host":"mac"}
{"id":"ai-inputs","host":"mac"}
{"id":"ai-gates","host":"mac"}
{"id":"ai-prepare","host":"mac"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-inputs","host":"box"}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-edge-receipt","host":"box","input":"EDGE_MEASUREMENT_FILE=W6 edge-measurement-final.json"}
{"id":"ai-edge-refresh","host":"box","input":"Only stale receipt; retain new receipt and use it","when":{"line":1045,"quote":"ai-close. Before a W5/W6/W7 open whose receipt is stale, HezLead runs\n`ai-edge-refresh`, which owns the timer for that step only and always re-arms it."}}
{"id":"ai-box-preflight","host":"box"}
{"id":"ai-open","host":"box"}
{"id":"ai-open-abort","host":"box","input":"Failure branch only: no production operation occurred; STOP forward order after abort","when":{"line":6968,"quote":"# host: box root; no production operation occurred before failed open"}}
{"id":"ai-db-session","host":"box"}
{"id":"ai-w7-timer-hold","host":"box","input":"Source in the persistent W7 shell; hold recycle timer through proof and close; verify recycle service inactive"}
{"id":"ai-w7-preflight","host":"box"}
{"id":"ai-w7-proof","host":"box"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=after; use independently produced after receipt and matching consent receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=success"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-close","host":"mac"}
```

```c1-order W7 rollback
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w7-recovery","host":"box","input":"Preserve W6 measured OPEN/CLOSED state; restore recycle timer; never activation rollback"}
```

```c1-order W7 recovered-close
{"id":"ai-recovery-env","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-db-session","host":"box","input":"Only if original box shell was lost; use exactly one new persistent root shell; recover existing protected window variables, never ai-open","when":{"line":649,"quote":"   blocks run in M. The rule applies to forward runs AND recovered closes. If\n   the box shell is lost, STOP: a recovered close opens one new persistent root\n   shell, re-runs ai-db-session in it, and runs the recovery blocks there."}}
{"id":"ai-w7-recovery","host":"box","input":"Preserve W6 measured OPEN/CLOSED state; restore recycle timer; never activation rollback"}
{"id":"ai-ordinary-probes","host":"mac"}
{"id":"ai-live-controls","host":"box","input":"LIVE_CONTROLS_EXPECT_PHASE=recovery; independently produced recovery receipt"}
{"host":"box","manual":{"line":652,"quote":"3. **One closer.** A window has exactly one closer: the shell that runs\n   ai-close. Before any close (forward or recovered), no other shell, worker or\n   script may still act on the window. If one does, stop it first and record it.\n4. **No box shell waits on a future file.** A box shell never polls for a"}}
{"id":"ai-close","host":"box","input":"CLOSE_RESULT=recovered; existing proof/secret paths; every embedded rollback outcome check must pass"}
{"host":"mac","manual":{"line":7159,"quote":"assignment. Every close is recorded in the operator's LOG.md with actual\nstart/end, identities, gate/probe receipts, approved rollback decision and\nsecret cleanup outcome. This preparation LOG contains no execution claims."}}
{"id":"ai-mac-recovery-env","host":"mac","input":"Only if original Mac shell was lost; recover PREP_DIR from the single matching prep directory","when":{"line":651,"quote":"If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close."}}
{"id":"ai-mac-close","host":"mac"}
```

not-run: {"id":"ai-extract","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-recycle-inventory","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-edge-remeasure","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-backup-gate-check","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-gates-bind","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-w2-backfill","reason":"Helper used by its existing W2/W2b caller; never dispatch twice"}
not-run: {"id":"ai-w2-measure","reason":"Helper used by its existing W2/W2b caller; never dispatch twice"}
not-run: {"id":"ai-w2-between-probes","reason":"Helper used by its existing W2/W2b caller; never dispatch twice"}
not-run: {"id":"ai-w2-revoke-probes","reason":"Helper used by its existing W2/W2b caller; never dispatch twice"}
not-run: {"id":"ai-w2b-proof-check","reason":"Helper used by its existing W2/W2b caller; never dispatch twice"}
not-run: {"id":"ai-release-aside","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-timer-guard","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-recycle-hook","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-recycle-install","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-recycle-rollback","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-w6-issuer-live","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-w6-activation-rollback","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}
not-run: {"id":"ai-w6-closed-gate-probe","reason":"Helper used by an existing marked block or outside-window preparation; execute only through its stated caller"}

## Failure handling

After any failure STOP forward work and record the step and fixed failure code in
LOG.md. Do not print exceptions, SQL result rows, docker inspect, resolved env,
token/proof/callback bodies, headers, cookies or request URLs. Private tool
diagnostics live only in SECRET_STAGE and are removed at close. Unknown COMMIT
or command outcome requires read-only reconciliation, never automatic retry.
A failing rollback is an ongoing incident: keep the window open, report it and
retain recovery inputs. Close requires successful probes/recovery and removes
only the exact validated task secret directory with the guarded `rm`; refusal
leaves it in place and reports the exact path/message. Immutable releases and
nonsecret proofs are retained. Closed windows cannot be reused.

`EDGE_MEASUREMENT_FILE` is an absolute regular nonsecret copy of W4
`edge-measurement.json`, including `generation` and `invalidated_at`. W5 open
and W6 open/checks/apply query the box again; a recycle makes an older receipt
unusable. After a recycle, retain fresh measurement evidence before reopening.
The recycle hook already binds its reopen to the current locked generation.
## Execution rulings (frozen bundle, 2026-10-04)

For W6, M owns the one persistent B session through descriptor 9. Before
sending any box block, open it in M with
`exec 9> >(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 sudo -n /bin/bash)`
and set `export C1_BOX_STDIN_FD=9`. Send the reviewed box inputs, open/session
and subsequent B blocks through that descriptor, in the listed order, verifying
each result before the next step. Do not open a second B shell. The concurrent
Mac fence driver inherits descriptor 9; after uploading agent.json it dispatches
ai-w6-audit through that same channel. B has no receipt watcher. Mac may wait
for the resulting audit file under its existing fence deadline. Stop the driver
and close descriptor 9 before the sole closer finishes. A lost ssh channel is
a STOP and requires the stated recovery-shell procedure, never automatic retry.


These rulings were given by message during the Z/Z2 windows. They are plan text
now; a task file may repeat them but never weakens them. Each is a STOP rule.

1. **Conditional public W3 probe.** W3 always runs ai-w3-local-gate at loopback.
   It runs the public ai-w3-probes only if the baseline Caddy already routes
   `/admin/gate` (measured, never guessed); a public 404 before W4 is expected
   unavailable ingress, never gate closed (see the W3 section). W4 makes the
   public probe mandatory with CORS.
2. **Persistent driver contract.** One window has exactly two shells: one
   persistent Mac `/bin/bash` 3.2 shell M, and ONE persistent root shell on the
   box, opened once over ssh from M. Every box block runs WHOLE on that root
   shell's stdin, in plan order; no other ssh shell runs a box block. Mac-only
   blocks run in M. The rule applies to forward runs AND recovered closes. If
   the box shell is lost, STOP: a recovered close opens one new persistent root
   shell, re-runs ai-db-session in it, and runs the recovery blocks there. If the Mac shell is lost, STOP: a recovered close opens one new persistent Mac /bin/bash 3.2 shell, runs ai-mac-recovery-env in it, then ai-mac-close.
3. **One closer.** A window has exactly one closer: the shell that runs
   ai-close. Before any close (forward or recovered), no other shell, worker or
   script may still act on the window. If one does, stop it first and record it.
4. **No box shell waits on a future file.** A box shell never polls for a
   receipt or file that a later step or another host will produce. A block that
   needs such a file runs only after the file exists; a worker whose local ssh
   dies must not leave a box-side shell behind (W2b close, 2026-10-04).
5. **W2 apply-time gate.** ai-w2-apply starts only when `window_end_utc - now
   >= 600 s` on the box clock; otherwise STOP before the fence and close
   pre-fence. No deadline check runs after the fence.
6. **W7 second checker receipt.** ai-gates requires `admin-c1-smoke` in the W7
   receipt, and its evidence is the production C1.json, which exists only after
   W6. W7 therefore uses a SECOND checker receipt, produced after W6, with its
   own `gate_receipt_sha256` in the W7 INPUTS; its `admin-c1-smoke` evidence
   file is the production C1.json of the W6 bound by `w6_window_id` (the digest
   ai-w7-preflight measures). The W6 receipt carries `admin-c1-smoke` on its
   pre-production evidence; the client-verification row stores that receipt.
7. **Missed fence.** If the W6 fence driver misses its cutoff (the normal
   human revoke is refused after the cutoff), the close is pre-decided:
   ai-emergency-close, then the recovery revoke (`C1_RECOVERY_REVOKE=1`,
   recorded as `human-revoke-recovery.json`, never as C1 refusal proof), then
   the owner withdraw, then a recovered close, then report STOP. Keep-open is
   lost in that case (ai-emergency-close closes issuance).
8. **Owner session: one caller.** The owner file-store session
   (`/Users/yulanbot/.cswarm/credentials.d`) has one caller at a time:
   ai-w6-c1-inputs, the owner approve, the fence chain and the withdraw never
   overlap each other or a controls-worker run that uses the same store.

## Marked common blocks

```sh
# step: ai-inputs
# readonly: yes
# host: Mac or box /bin/bash 3.2
set -euo pipefail
: "${INPUTS_FILE:?}" "${PLAN_FILE:?}" "${GATE_RECEIPT_FILE:?}"
python3 - "$INPUTS_FILE" "$PLAN_FILE" "$GATE_RECEIPT_FILE" <<'PY'
import datetime, hashlib, json, os, pathlib, re, stat, sys
def need(ok, reason):
    if not ok: raise SystemExit('FAIL ai-inputs: '+reason+'; STOP')
def regular(name):
    p=pathlib.Path(name)
    need(p.is_absolute() and p.is_file() and not p.is_symlink(), 'regular absolute input file')
    return p
p=regular(sys.argv[1])
input_bytes=p.read_bytes()
d=json.loads(input_bytes)
# Marker admission precedes receipt/identity/deadline validation and any side effect.
marker_path='/etc/commonswarm-release/STAGING-ONLY'
marker_content=b'c1-staging-disposable-no-production'
wid=d.get('window_id') if isinstance(d,dict) else None
stg=isinstance(wid,str) and re.match(r'^stg',wid,re.I) is not None
windows=['W'+str(x) for x in range(1,8)]+['W2b']
if sys.platform == 'darwin':
    if stg:
        need(re.fullmatch(r'STG[A-Za-z0-9]{3}',wid) is not None, 'Mac staging window_id expected STG-plus-three-alphanumerics got other')
        need(d.get('window') in windows, 'window')
        try:
            evidence=p.parent/('measurements-baselines-'+d['window']+'.json')
            need(evidence.is_file() and not evidence.is_symlink(), 'Mac staging evidence expected valid box marker got missing-or-malformed')
            measured=json.loads(evidence.read_bytes())
            marker=measured['staging_marker']
            need(isinstance(marker,dict) and set(marker)=={'path','regular','symlink','uid','gid','mode','content'} and
                 marker['path']==marker_path and marker['regular'] is True and marker['symlink'] is False and
                 type(marker['uid']) is int and marker['uid']==0 and type(marker['gid']) is int and marker['gid']==0 and
                 marker['mode']=='0600' and marker['content']==marker_content.decode('ascii'),
                 'Mac staging evidence expected valid box marker got missing-or-malformed')
            need(all(measured[k]==d[k] for k in ('release_sha','window','window_id')) and
                 measured['inputs_sha256']==hashlib.sha256(input_bytes).hexdigest(),
                 'Mac staging evidence expected this-window INPUTS bytes got mismatch')
            baselines=measured['baselines']
            need(isinstance(baselines,dict) and baselines and all(k.startswith('baseline_') and k in d and d[k]==v for k,v in baselines.items()),
                 'Mac staging evidence expected matching box baselines got mismatch')
            at=datetime.datetime.strptime(measured['measured_at_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
            need(0<=(datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<=300,
                 'Mac staging evidence expected fresh box measurement got stale-or-future')
        except (OSError,ValueError,TypeError,KeyError):
            need(False,'Mac staging evidence expected valid box marker got missing-or-malformed')
else:
    try:
        fd=os.open(marker_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        # lstat distinguishes an absent marker from a dangling symlink.
        need(not os.path.lexists(marker_path), 'box staging marker expected regular-root-root-0600-exact-content got malformed')
        need(not stg, 'production box window_id expected non-stg-prefix got reserved-stg-prefix')
    except OSError:
        need(False,'box staging marker expected regular-root-root-0600-exact-content got malformed')
    else:
        try:
            info=os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size==len(marker_content) and
                 os.read(fd,len(marker_content)+1)==marker_content,
                 'box staging marker expected regular-root-root-0600-exact-content got malformed')
        except OSError:
            need(False,'box staging marker expected regular-root-root-0600-exact-content got malformed')
        finally: os.close(fd)
        need(isinstance(wid,str) and re.fullmatch(r'STG[A-Za-z0-9]{3}',wid) is not None,
             'staging box window_id expected STG-plus-three-alphanumerics got other')
plan,receipt=map(regular,sys.argv[2:])
keys='release_sha plan_sha256 archive_sha256 window window_id window_end_utc baseline_oauth_sha baseline_oauth_image baseline_edge_sha baseline_edge_image baseline_stack_sha baseline_postgres_image baseline_site_sha baseline_site_target baseline_mcp_caddy_sha256 baseline_api_caddy_sha256 baseline_caddyfile_sha256 baseline_ledger_sha256 gate_receipt_sha256 rollback_decision approval legacy_fence_approval edge_recycle_service edge_recycle_timer edge_recycle_sha256'.split()
need(isinstance(d,dict) and set(keys)<=set(d)<=set(keys)|{'keep_open','keep_open_approval','probe_workspace_id','w2_release_sha','w2_window_id','w2b_release_sha','w2b_window_id','w6_window_id'}, 'required input keys')
for k in keys:
    if k.endswith('_sha'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{40}',d[k]), k)
    elif k.endswith('_sha256'):
        need(isinstance(d[k],str) and re.fullmatch('[0-9a-f]{64}',d[k]), k)
    elif k.endswith('_image'):
        need(isinstance(d[k],str) and re.fullmatch('sha256:[0-9a-f]{64}',d[k]), k)
for k,suffix in [('edge_recycle_service','.service'),('edge_recycle_timer','.timer')]:
    need(isinstance(d[k],str) and re.fullmatch(r'[A-Za-z0-9_-]+'+re.escape(suffix),d[k]), k)
need(d['window'] in windows, 'window')
need(isinstance(d['window_id'],str) and re.fullmatch('[A-Za-z0-9]{6}',d['window_id']), 'window_id')
need(isinstance(d['window_end_utc'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',d['window_end_utc']), 'window_end_utc')
end=datetime.datetime.strptime(d['window_end_utc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
# HezLead ruling: W6 (activation, consent and C1 smoke in one window) may last 90 minutes; every other window 30.
need(0<(end-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=(5400 if d['window']=='W6' else 1800), 'fresh deadline')
need(re.fullmatch(r'/srv/commonswarm/site/releases/[A-Za-z0-9._-]+',d['baseline_site_target']) is not None, 'site target')
need(hashlib.sha256(plan.read_bytes()).hexdigest()==d['plan_sha256'], 'plan bytes')
need(hashlib.sha256(receipt.read_bytes()).hexdigest()==d['gate_receipt_sha256'], 'checker receipt bytes')
decision={'W1':'retain-additive','W2':'retain-additive','W2b':'retain-additive','W3':'restore-service','W4':'restore-service','W5':'restore-service','W6':'close-and-reconcile','W7':'close-and-reconcile'}
need(d['rollback_decision']==decision[d['window']], 'rollback decision')
def approval(v,action):
    need(isinstance(v,dict) and set(v)=={'approver','action','release_sha','window_id','plan_sha256','prompt_ref'}, action+' approval required')
    need(v['approver'] in ('Tom','HezLead') and v['action']==action and
         all(v[k]==d[k] for k in ('release_sha','window_id','plan_sha256')) and
         isinstance(v['prompt_ref'],str) and re.fullmatch('[A-Za-z0-9/_.:-]{1,200}',v['prompt_ref']), action+' approval binding')
action={'W6':'activate-admin-issuance-and-smoke','W7':'retire-legacy-admin-mint'}.get(d['window'])
if action: approval(d['approval'],action)
else: need(d['approval'] is None, 'no implicit activation approval')
need(type(d.get('keep_open',False)) is bool, 'keep_open boolean')
if d.get('keep_open',False):
    need(d['window']=='W6','keep-open window')
    approval(d.get('keep_open_approval'),'keep-admin-issuance-open')
else: need(d.get('keep_open_approval') is None,'no unused keep-open approval')
if d['window']=='W2': need(isinstance(d.get('probe_workspace_id'),str) and re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',d['probe_workspace_id']) is not None, 'W2 probe_workspace_id')
else: need('probe_workspace_id' not in d, 'probe_workspace_id is W2-only')
if d['window']=='W2b':
    need(isinstance(d.get('w2_release_sha'),str) and re.fullmatch('[0-9a-f]{40}',d['w2_release_sha']) is not None, 'W2b w2_release_sha')
    need(isinstance(d.get('w2_window_id'),str) and re.fullmatch('[A-Za-z0-9]{6}',d['w2_window_id']) is not None, 'W2b w2_window_id')
else: need('w2_release_sha' not in d and 'w2_window_id' not in d, 'w2_release_sha/w2_window_id are W2b-only')
if d['window']=='W6':
    need(isinstance(d.get('w2b_release_sha'),str) and re.fullmatch('[0-9a-f]{40}',d['w2b_release_sha']) is not None, 'W6 w2b_release_sha')
    need(isinstance(d.get('w2b_window_id'),str) and re.fullmatch('[A-Za-z0-9]{6}',d['w2b_window_id']) is not None, 'W6 w2b_window_id')
else: need('w2b_release_sha' not in d and 'w2b_window_id' not in d, 'w2b_release_sha/w2b_window_id are W6-only')
if d['window']=='W7': need(isinstance(d.get('w6_window_id'),str) and re.fullmatch('[A-Za-z0-9]{6}',d['w6_window_id']) is not None, 'W7 w6_window_id')
else: need('w6_window_id' not in d, 'w6_window_id is W7-only')
if d['window']=='W4': approval(d['legacy_fence_approval'],'terminal-legacy-db-fence')
else: need(d['legacy_fence_approval'] is None, 'legacy fence approval scope')
print('PASS ai-inputs: exact identities, deadline, rollback and approval bindings')
PY
```

```sh
# step: ai-prepare
# readonly: no
# host: Mac /bin/bash 3.2, outside window
set -euo pipefail
# Run ai-inputs first. This step creates nonsecret archive/transport files only.
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
PREP_GIT_STATUS=$(git status --porcelain)
test -z "$PREP_GIT_STATUS"
git fetch origin main
test "$(git rev-parse --verify "${RELEASE_SHA}^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
BASELINE_SITE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_site_sha"])' "$INPUTS_FILE")
test "$(git rev-parse --verify "${BASELINE_SITE_SHA:0:12}^{commit}")" = "$BASELINE_SITE_SHA"
test "$(git remote get-url origin)" = git@github.com:yulanventures/commonswarm.git
PREP_DIR=$(mktemp -d /private/tmp/admin-issuance-prep.XXXXXX)
chmod 0700 "$PREP_DIR"
git archive --format=tar "$RELEASE_SHA" >"$PREP_DIR/release.tar"
git show "${RELEASE_SHA}:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" >"$PREP_DIR/RELEASE.md"
cmp -s "$PLAN_FILE" "$PREP_DIR/RELEASE.md"
ARCHIVE_SHA256=$(shasum -a 256 "$PREP_DIR/release.tar" | awk '{print $1}')
test "$ARCHIVE_SHA256" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")"
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${RELEASE_SHA}-${WINDOW_ID}.tar
chmod 0600 "$PREP_DIR/release.tar"
printf -v REMOTE 'test ! -e %q && (set -C; umask 077; : > %q)' "$BOX_ARCHIVE_PATH" "$BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE"
scp -p "$PREP_DIR/release.tar" "ops@100.115.66.74:$BOX_ARCHIVE_PATH"
printf 'PASS ai-prepare: archive retained at %s; upload %s\n' "$PREP_DIR" "$BOX_ARCHIVE_PATH"
```

```sh
# step: ai-extract
# readonly: no
# host: Mac /bin/bash 3.2, outside window; no execution
set -euo pipefail
: "${PLAN_FILE:?}" "${STEP_ID:?}" "${PREP_DIR:?}" "${INPUTS_FILE:?}"
python3 - "$PLAN_FILE" "$STEP_ID" "$PREP_DIR/step.sh" "$INPUTS_FILE" <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(sys.argv[1],sys.argv[4],'ai-extract').decode(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1 and re.fullmatch('ai-[a-z0-9-]+',sys.argv[2]), 'FAIL extraction; STOP'
body=found[0].encode()
# Syntax-check the verified bytes in memory, write them once, then re-read by fd.
if subprocess.run(['/bin/bash','-n'],input=body).returncode!=0: raise SystemExit('FAIL ai-extract: step syntax expected valid got invalid; STOP')
try: fd=os.open(sys.argv[3],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
except OSError: raise SystemExit('FAIL ai-extract: step.sh expected writable-regular-file got symlink-or-unwritable; STOP') from None
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise SystemExit('FAIL ai-extract: step.sh expected regular-file got other; STOP')
    os.fchmod(fd,0o600); os.write(fd,body)
finally: os.close(fd)
written=read_regular(sys.argv[3])
if written is None or hashlib.sha256(written).digest()!=hashlib.sha256(body).digest(): raise SystemExit('FAIL ai-extract: step.sh expected verified-bytes got changed; STOP')
PY
```

```sh
# step: ai-recycle-inventory
# readonly: yes
# host: HezLead box root preflight, before window inputs are finalized
set -euo pipefail
python3 - <<'PY'
import hashlib,json,re,subprocess
rows=subprocess.check_output(['systemctl','list-unit-files','--type=timer','--no-legend','--no-pager'],text=True,stderr=subprocess.DEVNULL).splitlines()
found=[]
for row in rows:
    timer=row.split()[0]
    if not re.fullmatch(r'[A-Za-z0-9_-]+\.timer',timer): continue
    services=subprocess.check_output(['systemctl','show','-p','Triggers','--value',timer],text=True,stderr=subprocess.DEVNULL).split()
    for service in services:
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.service',service): continue
        unit=subprocess.check_output(['systemctl','cat',service],text=True,stderr=subprocess.DEVNULL).strip()+'\n'
        if 'docker' in unit and 'restart' in unit and 'commonswarm-edge' in unit:
            found.append({'edge_recycle_timer':timer,'edge_recycle_service':service,'edge_recycle_sha256':hashlib.sha256(unit.encode()).hexdigest()})
assert len(found)==1, 'FAIL unique edge recycle unit discovery required; STOP'
print(json.dumps(found[0],sort_keys=True))
PY
```

```sh
# step: ai-box-preflight
# readonly: yes
# host: approved box root Bash shell; repeat immediately before open
set -euo pipefail
test "$(id -u)" = 0
# ai-inputs has run in this shell with box-local regular input/plan/receipt files.
python3 - "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,re,subprocess,sys
d=json.load(open(sys.argv[1]))
def need(ok,reason):
    if not ok: raise SystemExit('FAIL ai-box-preflight: '+reason+'; STOP')
def output(args): return subprocess.check_output(args,stderr=subprocess.DEVNULL,text=True).strip()
def inspect(name): return json.loads(output(['docker','inspect',name]))[0]
for part,container,service in [('oauth','commonswarm-oauth-oauth-1','oauth'),('edge','commonswarm-edge-edge-runtime-1','edge-runtime')]:
    target=pathlib.Path('/home/commonswarm/'+part+'/current').resolve(strict=True)
    need(str(target)=='/home/commonswarm/'+part+'/releases/'+d['baseline_'+part+'_sha'],part+' current')
    need((target/'RELEASE_SHA').read_text().strip()==d['baseline_'+part+'_sha'],part+' source')
    c=inspect(container); labels=c['Config']['Labels']
    need(c['State'].get('Health',{}).get('Status')=='healthy',part+' healthy')
    need(c['Image']==d['baseline_'+part+'_image'],part+' image')
    need(labels.get('com.docker.compose.project')=='commonswarm-'+part and labels.get('com.docker.compose.service')==service,part+' Compose labels')
    need(labels.get('com.docker.compose.project.working_dir')==str(target/'deploy'/('mcp-auth' if part=='oauth' else 'edge-runtime')),part+' live source mount/working directory')
    env=dict(x.split('=',1) for x in c['Config']['Env'])
    need(env.get('MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED' if part=='oauth' else 'SWARM_MCP_PUBLIC_ENABLED')=='1',part+' ordinary MCP ON')
    need(not any(k.startswith(('SWARM_CMD_TEST_','MCP_OAUTH_TEST_')) for k in env),part+' test-hook absence')
    if part=='oauth':
        label=output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',c['Image']])
        need(label==d['baseline_oauth_sha'],'OAuth image source label')
    else:
        need(c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648,'edge network/memory')
        for destination,source in [('/home/deno/main',target/'deploy/edge-runtime/main'),('/home/deno/functions-source',target/'supabase/functions'),('/var/src',target/'src')]:
            rows=[m for m in c['Mounts'] if m['Destination']==destination]
            need(len(rows)==1 and rows[0]['Source']==str(source) and not rows[0]['RW'],'edge immutable mounts')
stack=pathlib.Path('/home/commonswarm/stack/current').resolve(strict=True)
need(str(stack)=='/home/commonswarm/stack/releases/'+d['baseline_stack_sha'],'stack current')
need((stack/'RELEASE_SHA').read_text().strip()==d['baseline_stack_sha'],'stack source')
need(inspect('commonswarm-postgres')['Image']==d['baseline_postgres_image'],'database image')
need(pathlib.Path('/srv/commonswarm/site/current').resolve(strict=True)==pathlib.Path(d['baseline_site_target']),'site target')
# Site release names encode a source prefix; ai-prepare/site plan resolves it against Git.
site_name=pathlib.Path(d['baseline_site_target']).name
match=re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}',site_name)
need(match is not None and match[1]==d['baseline_site_sha'][:12],'site recorded source prefix')
for name,path in [('mcp','/etc/caddy/sites/20-commonswarm-mcp.caddy'),('api','/etc/caddy/sites/10-commonswarm-api.caddy'),('caddyfile','/etc/caddy/Caddyfile')]:
    key='baseline_'+(name+'_caddy' if name!='caddyfile' else name)+'_sha256'
    p=pathlib.Path(path); need(p.is_file() and not p.is_symlink(),name+' Caddy regular file')
    need(hashlib.sha256(p.read_bytes()).hexdigest()==d[key],name+' Caddy bytes')
need(output(['systemctl','is-active',d['edge_recycle_timer']])=='active','recycle timer active')
need(output(['systemctl','show','-p','ActiveState','--value',d['edge_recycle_service']])=='inactive','recycle service inactive')
need(d['edge_recycle_service'] in output(['systemctl','show','-p','Triggers','--value',d['edge_recycle_timer']]).split(),'timer target')
unit=output(['systemctl','cat',d['edge_recycle_service']])+'\n'
need(hashlib.sha256(unit.encode()).hexdigest()==d['edge_recycle_sha256'],'recycle unit bytes')
need('docker' in unit and 'restart' in unit and 'commonswarm-edge' in unit,'measured edge recycle operation')
need(output(['systemctl','show','-p','User','--value',d['edge_recycle_service']]) in ('','root'),'root recycle unit')
print('PASS ai-box-preflight: baseline reconciled; paths/images/ON flags/Caddy exact')
PY
```

```sh
# step: ai-edge-receipt
# readonly: yes
# host: box root; EDGE_RECEIPT_REMOTE=1 queries the box from the W5 Mac wrapper
set -euo pipefail
: "${EDGE_MEASUREMENT_FILE:?current edge-measurement.json required}"
python3 - "$INPUTS_FILE" "$EDGE_MEASUREMENT_FILE" <<'PY'
import json,os,pathlib,re,shlex,subprocess,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2])
def need(ok,field):
    if not ok: raise SystemExit('FAIL edge-measurement.json: '+field+'; STOP')
need(p.is_absolute() and p.is_file() and not p.is_symlink(),'EDGE_MEASUREMENT_FILE')
m=json.loads(p.read_text()); sha=d['release_sha']; image=d['baseline_postgres_image']
need(re.fullmatch('[0-9a-f]{40}',sha) is not None,'release_sha')
need(re.fullmatch('sha256:[0-9a-f]{64}',image) is not None,'baseline_postgres_image')
query=r'''
set -euo pipefail
umask 077
EDGE_QUERY_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX)
edge_query_cleanup() {
 python3 - "$EDGE_QUERY_STAGE" <<'EDGE_QUERY_CLEANUP' || return 1
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
EDGE_QUERY_CLEANUP
 rm -r -- "$EDGE_QUERY_STAGE"
}
trap edge_query_cleanup EXIT
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT
PG_SERVICE_OUTPUT="$EDGE_QUERY_STAGE/service.conf" PG_PASS_OUTPUT="$EDGE_QUERY_STAGE/pass" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "/home/commonswarm/admin-issuance/releases/$1/deploy/supabase-stack/migrate/make-pg-service.mjs" >"$EDGE_QUERY_STAGE/session.log" 2>&1
chmod 0600 "$EDGE_QUERY_STAGE/service.conf" "$EDGE_QUERY_STAGE/pass"
docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
 --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
 --volume "$EDGE_QUERY_STAGE/service.conf:/run/service.conf:ro" --volume "$EDGE_QUERY_STAGE/pass:/run/pass:ro" \
 --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
 --entrypoint psql "$2" -X --set=ON_ERROR_STOP=1 -Atq \
 --command 'SET default_transaction_read_only=on;' \
 --command 'SELECT row_to_json(r) FROM (SELECT release_generation,measured_generation,invalidated_at,approved_edge_release_sha,measured_edge_release_sha,measured_edge_target,measured_mount,measured_image_digest,measured_artifact_digest FROM commonswarm_oauth.admin_cutover_state WHERE singleton) r;' 2>"$EDGE_QUERY_STAGE/query.log"
'''
args=['/bin/bash','-s','--',sha,image]
if os.environ.get('EDGE_RECEIPT_REMOTE')=='1':
    args=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','ops@100.115.66.74','sudo -n '+shlex.join(args)]
try:
    row=json.loads(subprocess.check_output(args,input=query,text=True,stderr=subprocess.DEVNULL))
except Exception:
    raise SystemExit('FAIL edge-measurement.json: current release_generation/invalidated_at unavailable; STOP') from None
need(m.get('invalidated_at','missing') is None and row.get('invalidated_at','missing') is None,'invalidated_at')
need(type(m.get('generation')) is int and m['generation']>0 and m['generation']==row.get('release_generation')==row.get('measured_generation'),'generation/release_generation/measured_generation')
for field,observed in [('release_sha','measured_edge_release_sha'),('target','measured_edge_target'),('mount','measured_mount'),('image_digest','measured_image_digest'),('artifact_digest','measured_artifact_digest')]:
    need(m.get(field)==row.get(observed) and isinstance(m.get(field),str) and bool(m[field]),field+'/'+observed)
need(m['release_sha']==sha==row.get('approved_edge_release_sha'),'release_sha/approved_edge_release_sha')
need(m['target']==m['mount']=='/home/commonswarm/edge/releases/'+sha,'target/mount')
print('PASS current edge-measurement.json generation/invalidated_at/release_sha/target/mount/image_digest/artifact_digest')
PY
```

## Edge remeasure (shared by W5/W6/W7 opens, W6 apply and W6 finish)

A recycle (the six-hour timer or any hook run) increments `release_generation`,
so an older `edge-measurement.json` no longer matches the live row and
ai-edge-receipt STOPs. `ai-edge-remeasure` is the ONE producer of a fresh
receipt: with the recycle timer already stopped by its caller, it runs the
installed hook pair (before closes issuance and invalidates; after measures the
live edge against the root-owned recycle.json and reopens only a previously open,
still-approved release), reads the row with the exact query bytes of
ai-edge-receipt, writes the new receipt from recycle.json and that generation,
and then validates it with ai-edge-receipt itself. Two rules hold for every
block here: a CLOSED claim or a CLOSED marker exists ONLY right after a
successful independent readback, and everything else is UNKNOWN; and for
ai-edge-remeasure, ai-edge-refresh, ai-w6-activation-apply, ai-w6-finish and
ai-w6-activation-rollback, exit 1 means confirmed CLOSED, 2 means UNKNOWN and
any other nonzero status is UNKNOWN. Each of these blocks installs its status
trap as its first statement: an unconfirmed 1 becomes 2, and an exit before the
block's last line (even one that leaves $? at 0) becomes 2. ai_run returns 2
for any failure before it evaluates a block (allowlist, plan verification,
lookup, syntax), so a dispatch failure can never read as a confirmed close.
Every production node launch first unsets NODE_OPTIONS and the admin-smoke
test-transport variables; scripts/admin-smoke.mjs refuses fixture inputs and
the test transport refuses to load unless ADMIN_SMOKE_TEST_TRANSPORT=1, which
only the test harness sets. Any failure after the hooks start (a hook, the row read, the
receipt or its validation, possibly after a committed reopen) runs the hook's
`close` mode (release role, close first, then invalidate, marker reason
`remeasure-validation-failed`) before the step fails; a failed close is
reported separately ("issuance may be OPEN"). ai-edge-refresh, ai-w6-finish and
ai-w6-activation-rollback each run in their own subshell, so their EXIT traps
re-arm the recycle timer before control returns to the window shell and its
ai-close. Before a W5/W6/W7 open whose receipt is stale, HezLead runs
`ai-edge-refresh`, which owns the timer for that step only and always re-arms it.

```sh
# step: ai-edge-remeasure
# readonly: no
# host: box root; the CALLER has stopped the recycle timer and re-arms it afterwards
set -euo pipefail
# Status contract (also ai-edge-refresh, ai-w6-activation-apply, ai-w6-finish, ai-w6-activation-rollback): 0 success;
# 1 ONLY right after an independent readback confirmed issuance CLOSED; any other status (2 by convention) UNKNOWN.
C1_CLOSED_CONFIRMED=0
C1_BLOCK_DONE=0
remeasure_exit() {
 local status=$?
 trap - EXIT
 if test "$status" = 0 && test "${C1_BLOCK_DONE:-0}" != 1; then status=2; fi
 if test "$status" = 1 && test "${C1_CLOSED_CONFIRMED:-0}" != 1; then status=2; fi
 exit "$status"
}
trap remeasure_exit EXIT
: "${INPUTS_FILE:?FAIL ai-edge-remeasure: INPUTS_FILE expected absolute-file got unset; STOP}" "${PLAN_FILE:?FAIL ai-edge-remeasure: PLAN_FILE expected absolute-file got unset; STOP}"
: "${EDGE_MEASUREMENT_OUT:?FAIL ai-edge-remeasure: EDGE_MEASUREMENT_OUT expected absolute-new-file got unset; STOP}"
case "$EDGE_MEASUREMENT_OUT" in /*) ;; *) printf 'FAIL ai-edge-remeasure: EDGE_MEASUREMENT_OUT expected absolute-path got relative; STOP\n' >&2; exit 1;; esac
if test -e "$EDGE_MEASUREMENT_OUT" || test -L "$EDGE_MEASUREMENT_OUT"; then printf 'FAIL ai-edge-remeasure: EDGE_MEASUREMENT_OUT expected absent got present; STOP\n' >&2; exit 1; fi
REMEASURE_TIMER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_timer"])' "$INPUTS_FILE") || { printf 'FAIL ai-edge-remeasure: recycle timer name expected readable got failure; STOP\n' >&2; exit 1; }
REMEASURE_SERVICE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_service"])' "$INPUTS_FILE") || { printf 'FAIL ai-edge-remeasure: recycle service name expected readable got failure; STOP\n' >&2; exit 1; }
if systemctl is-active --quiet "$REMEASURE_TIMER"; then printf 'FAIL ai-edge-remeasure: recycle timer expected stopped-by-caller got active; STOP\n' >&2; exit 1; fi
test "$(systemctl show -p ActiveState --value "$REMEASURE_SERVICE")" = inactive || { printf 'FAIL ai-edge-remeasure: recycle service expected inactive got other; STOP\n' >&2; exit 1; }
# Any failure from here on may follow a committed reopen: close and invalidate (hook close mode, release role,
# close first) before returning failure, and report a failed close separately.
# Exit 1: failed, issuance CLOSED (confirmed by the close mode's readback). Exit 2: failed, state UNKNOWN.
remeasure_fail() {
 if COMMONSWARM_RECYCLE_UNIT=ai-edge-remeasure /usr/local/libexec/commonswarm-admin-edge-recycle close; then
  C1_CLOSED_CONFIRMED=1
  printf 'FAIL ai-edge-remeasure: failure close confirmed issuance CLOSED by readback; STOP\n' >&2; exit 1
 fi
 printf 'FAIL ai-edge-remeasure: failure close expected issuance closed got failure; issuance state UNKNOWN (may be OPEN); run ai-emergency-close; STOP\n' >&2
 exit 2
}
COMMONSWARM_RECYCLE_UNIT=ai-edge-remeasure /usr/local/libexec/commonswarm-admin-edge-recycle before || { printf 'FAIL ai-edge-remeasure: recycle hook before expected success got failure; STOP\n' >&2; remeasure_fail; }
COMMONSWARM_RECYCLE_UNIT=ai-edge-remeasure /usr/local/libexec/commonswarm-admin-edge-recycle after || { printf 'FAIL ai-edge-remeasure: recycle hook after expected measured got failure; STOP\n' >&2; remeasure_fail; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$EDGE_MEASUREMENT_OUT" <<'PY' || { printf 'FAIL ai-edge-remeasure: receipt validation after the hook pair expected PASS got failure; STOP\n' >&2; remeasure_fail; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,out=sys.argv[1:4]
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-edge-remeasure: '+what+' expected '+expected+' got '+got+'; STOP')
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
d=json.load(open(inputs)); sha=d['release_sha']
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,'ai-edge-remeasure').decode(),re.M|re.S)
receipt=[b for b in blocks if b.startswith('# step: ai-edge-receipt\n')]
need(len(receipt)==1,'ai-edge-receipt block','one','other')
query=re.findall(r"^query=r'''\n(.*?)\n'''$",receipt[0],re.M|re.S)
need(len(query)==1,'ai-edge-receipt row query','one','other')
# The recycle input is the hook's own reference (the hook pair above already required it root-owned 0600).
r_raw=read_regular('/etc/commonswarm-admin-release/recycle.json')
need(r_raw is not None,'recycle.json','regular-file','missing-or-not-regular')
need(stat.S_IMODE(os.stat('/etc/commonswarm-admin-release/recycle.json').st_mode)==0o600,'recycle.json mode','0600','other')
r=json.loads(r_raw)
need(r.get('release_sha')==sha and r.get('target')=='/home/commonswarm/edge/releases/'+sha,'recycle.json release','this-release','other')
try:
    row=json.loads(subprocess.check_output(['/bin/bash','-s','--',sha,d['baseline_postgres_image']],input=query[0]+'\n',text=True,stderr=subprocess.DEVNULL))
except Exception:
    raise SystemExit('FAIL ai-edge-remeasure: cutover row expected readable got failure; STOP') from None
gen=row.get('release_generation')
need(type(gen) is int and gen>0 and gen==row.get('measured_generation') and row.get('invalidated_at','missing') is None,'measured generation','measured-and-not-invalidated','stale-or-invalidated')
need(row.get('approved_edge_release_sha')==sha and row.get('measured_edge_release_sha')==sha,'approved/measured edge release','this-release','other')
for field,observed in (('target','measured_edge_target'),('target','measured_mount'),('image_digest','measured_image_digest'),('artifact_digest','measured_artifact_digest')):
    need(r.get(field)==row.get(observed),observed,'recycle.json '+field,'other')
m={'release_sha':sha,'target':r['target'],'mount':r['target'],'image_digest':r['image_digest'],'artifact_digest':r['artifact_digest'],'generation':gen,'invalidated_at':None}
fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f: f.write(json.dumps(m,sort_keys=True)+'\n')
# The new receipt passes the same validator every open uses.
env=dict(os.environ,EDGE_MEASUREMENT_FILE=out,INPUTS_FILE=inputs)
need(subprocess.run(['/bin/bash'],input=receipt[0],text=True,env=env,stdout=subprocess.DEVNULL).returncode==0,'new edge-measurement.json','valid-edge-receipt','refused')
print('PASS ai-edge-remeasure: hook pair measured generation '+str(gen)+'; fresh edge-measurement.json validated')
PY
# Reached only by running to the end: an early exit (an expansion error can leave $? at 0) is never success.
C1_BLOCK_DONE=1
```

```sh
# step: ai-edge-refresh
# readonly: no
# host: HezLead box root, before ai-open of W5/W6/W7 when ai-edge-receipt finds the receipt stale; owns the recycle timer for this step only
# Own subshell: the EXIT trap re-arms the timer BEFORE control returns to the window shell (ai_run is eval).
(
C1_CLOSED_CONFIRMED=0 REFRESH_TIMER=
C1_BLOCK_DONE=0
edge_refresh_rearm() {
 local status=$?
 trap - EXIT
 if test "$status" = 0 && test "${C1_BLOCK_DONE:-0}" != 1; then status=2; fi
 # Every exit re-arms the timer once its name is known; a failed re-arm is reported and fails the step.
 if test -n "${REFRESH_TIMER:-}"; then
  systemctl start "$REFRESH_TIMER" || { printf 'FAIL ai-edge-refresh: recycle timer start expected success got failure; STOP\n' >&2; test "$status" != 0 || status=3; }
  systemctl is-active --quiet "$REFRESH_TIMER" || { printf 'FAIL ai-edge-refresh: recycle timer expected active got inactive; STOP\n' >&2; test "$status" != 0 || status=3; }
 fi
 # Status contract (first statement of the block): 1 only after a confirmed CLOSED readback; anything else UNKNOWN.
 if test "$status" = 1 && test "${C1_CLOSED_CONFIRMED:-0}" != 1; then status=2; fi
 exit "$status"
}
trap edge_refresh_rearm EXIT
set -euo pipefail
: "${INPUTS_FILE:?}" "${PLAN_FILE:?}" "${EDGE_MEASUREMENT_OUT:?}"
REFRESH_TIMER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_timer"])' "$INPUTS_FILE") || { REFRESH_TIMER=; printf 'FAIL ai-edge-refresh: recycle timer name expected readable got failure; STOP\n' >&2; exit 2; }
systemctl stop "$REFRESH_TIMER" || { printf 'FAIL ai-edge-refresh: recycle timer stop expected success got failure; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" ai-edge-refresh "$EDGE_MEASUREMENT_OUT" <<'PY' || { REFRESH_STATUS=$?; printf 'FAIL ai-edge-refresh: edge remeasure expected PASS got failure; STOP\n' >&2; if test "$REFRESH_STATUS" = 1; then C1_CLOSED_CONFIRMED=1; printf 'FAIL ai-edge-refresh: issuance CLOSED (remeasure failure close confirmed by readback); STOP\n' >&2; exit 1; fi; printf 'FAIL ai-edge-refresh: issuance state UNKNOWN after the remeasure failure (may be OPEN); run ai-emergency-close; STOP\n' >&2; exit 2; }
import hashlib,json,os,re,stat,subprocess,sys
# The child's 0 or 1 passes through; anything else, including this script's own failure, is 2 (UNKNOWN).
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
rc=2
try:
    blocks=re.findall(r'^```sh\n(.*?)^```$',verified_plan(sys.argv[1],sys.argv[2],sys.argv[3]).decode(),re.M|re.S)
    found=[b for b in blocks if b.startswith('# step: ai-edge-remeasure\n')]
    if len(found)!=1: raise SystemExit('FAIL ai-edge-refresh: ai-edge-remeasure block expected one got other; STOP')
    # The child bash gets its inputs explicitly; shell variables need not be exported.
    rc=(subprocess.run(['/bin/bash'],input=found[0],text=True,env=dict(os.environ,PLAN_FILE=sys.argv[1],INPUTS_FILE=sys.argv[2],EDGE_MEASUREMENT_FILE=os.environ.get('EDGE_MEASUREMENT_FILE',''),EDGE_MEASUREMENT_OUT=sys.argv[4])).returncode)
except BaseException as error:
    if isinstance(error,SystemExit) and isinstance(error.code,str): print(error.code,file=sys.stderr)
    rc=2
sys.exit(rc if rc in (0,1) else 2)
PY
printf 'PASS ai-edge-refresh: fresh edge-measurement.json at %s; recycle timer re-armed on exit\n' "$EDGE_MEASUREMENT_OUT"
# Reached only by running to the end: an early exit (an expansion error can leave $? at 0) is never success.
C1_BLOCK_DONE=1
)
```


```sh
# step: ai-open
# readonly: no
# host: box root; after repeated inputs/baseline preflight
set -euo pipefail
umask 077
if test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window"])' "$INPUTS_FILE")" = W6; then
 : "${W5_CLOSED_FILE:?}" "${BROWSER_READY_FILE:?}"
 python3 - "$INPUTS_FILE" "$W5_CLOSED_FILE" "$BROWSER_READY_FILE" <<'PY'
import datetime,json,pathlib,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
d=json.load(open(sys.argv[1])); close,ready=map(pathlib.Path,sys.argv[2:])
assert all(p.is_absolute() and p.is_file() and not p.is_symlink() for p in (close,ready)), 'FAIL W6 fresh BROWSER-READY required; STOP'
w=json.load(open(close.parent/'inputs.json')); assert w['release_sha']==d['release_sha'] and w['window']=='W5'
assert json.load(open(close.parent/'W5-closed.json'))['state']=='closed'
closed_at=box_utc(close.read_text().strip()); assert closed_at is not None, 'FAIL W5 closed.txt expected aware-UTC-ISO-8601-time got other; STOP'
t=closed_at.timestamp()
assert ready.stat().st_mtime>t and ready.stat().st_mtime<=datetime.datetime.now(datetime.timezone.utc).timestamp(), 'FAIL W6 BROWSER-READY must be newer than W5 close; STOP'
PY
fi
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
WINDOW=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window"])' "$INPUTS_FILE")
BOX_ARCHIVE_PATH=/tmp/admin-issuance-${RELEASE_SHA}-${WINDOW_ID}.tar
PROOF_DIR=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-${WINDOW}-${WINDOW_ID}
RELEASE_ROOT=/home/commonswarm/admin-issuance/releases/$RELEASE_SHA
if test "$WINDOW" = W2; then
 python3 - "$INPUTS_FILE" <<'PY' || { printf 'FAIL ai-open: W2 already-applied schema check expected zero-20261003 got refusal; STOP\n' >&2; exit 1; }
import json,os,pathlib,re,subprocess,sys
d=json.load(open(sys.argv[1])); sha=d['release_sha']; image=d['baseline_postgres_image']
query=r'''
set -euo pipefail
umask 077
EDGE_QUERY_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX)
edge_query_cleanup() {
 python3 - "$EDGE_QUERY_STAGE" <<'EDGE_QUERY_CLEANUP' || return 1
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
EDGE_QUERY_CLEANUP
 rm -r -- "$EDGE_QUERY_STAGE"
}
trap edge_query_cleanup EXIT
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT
PG_SERVICE_OUTPUT="$EDGE_QUERY_STAGE/service.conf" PG_PASS_OUTPUT="$EDGE_QUERY_STAGE/pass" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "/home/commonswarm/admin-issuance/releases/$1/deploy/supabase-stack/migrate/make-pg-service.mjs" >"$EDGE_QUERY_STAGE/session.log" 2>&1
chmod 0600 "$EDGE_QUERY_STAGE/service.conf" "$EDGE_QUERY_STAGE/pass"
docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
 --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
 --volume "$EDGE_QUERY_STAGE/service.conf:/run/service.conf:ro" --volume "$EDGE_QUERY_STAGE/pass:/run/pass:ro" \
 --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
 --entrypoint psql "$2" -X --set=ON_ERROR_STOP=1 -Atq \
 --command 'SET default_transaction_read_only=on;' \
 --command 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version LIKE $c1$20261003%$c1$;' 2>"$EDGE_QUERY_STAGE/query.log"
'''
try:
    n=subprocess.check_output(['/bin/bash','-s','--',sha,image],input=query,text=True,stderr=subprocess.DEVNULL).strip()
except Exception:
    raise SystemExit('FAIL ai-open: W2 ledger count expected readable got failure; STOP') from None
if n=='5':
    raise SystemExit('FAIL ai-open: W2 ledger expected no complete 20261003 set before open got 5; STOP')
if n!='0':
    raise SystemExit('FAIL ai-open: W2 ledger expected no 20261003 version before open got '+n+'; STOP')
print('PASS ai-open: W2 schema not yet applied')
PY
fi
case "$WINDOW" in W5|W6|W7)
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$EDGE_MEASUREMENT_FILE" ai-open <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^```sh\n(.*?)^```$',verified_plan(sys.argv[1],sys.argv[2],sys.argv[4]).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-edge-receipt\n')]; assert len(found)==1
# argv[3] is the shell's EDGE_MEASUREMENT_FILE; an unexported variable still reaches Python.
subprocess.run(['/bin/bash'],input=found[0],text=True,check=True,env=dict(os.environ,PLAN_FILE=sys.argv[1],INPUTS_FILE=sys.argv[2],EDGE_MEASUREMENT_FILE=sys.argv[3]))
PY
;; esac
test ! -e "$PROOF_DIR" || { printf 'FAIL ai-open: PROOF_DIR expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$PROOF_DIR" || { printf 'FAIL ai-open: PROOF_DIR expected not-symlink got symlink; STOP\n' >&2; exit 1; }
: "${LIVE_CONTROLS_FILE:?FAIL ai-open: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP}"
: "${CONSENT_RECEIPT_FILE:?FAIL ai-open: CONSENT_RECEIPT_FILE expected absolute-regular-file got unset; STOP}"
test -f "$BOX_ARCHIVE_PATH" || { printf 'FAIL ai-open: BOX_ARCHIVE_PATH expected regular-file got missing; STOP\n' >&2; exit 1; }
test ! -L "$BOX_ARCHIVE_PATH" || { printf 'FAIL ai-open: BOX_ARCHIVE_PATH expected not-symlink got symlink; STOP\n' >&2; exit 1; }
test "$(stat -c %a "$BOX_ARCHIVE_PATH")" = 600
OPEN_ARCHIVE_SHA256=$(sha256sum "$BOX_ARCHIVE_PATH" | awk '{print $1}')
OPEN_EXPECTED_ARCHIVE_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["archive_sha256"])' "$INPUTS_FILE")
test "$OPEN_ARCHIVE_SHA256" = "$OPEN_EXPECTED_ARCHIVE_SHA256"
# Live before receipt and its release-bound consent receipt (SCHEMA section 3);
# producer bytes come from the checksum-verified uploaded archive.
python3 - "$INPUTS_FILE" "$LIVE_CONTROLS_FILE" "$CONSENT_RECEIPT_FILE" "$BOX_ARCHIVE_PATH" <<'PY'
import datetime,hashlib,json,pathlib,re,sys,tarfile
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-open: '+what+' expected '+expected+' got '+got+'; STOP')
def receipt(name,label):
    p=pathlib.Path(name)
    need(p.is_absolute() and p.is_file() and not p.is_symlink(),label,'absolute-regular-file','missing-or-not-regular')
    raw=p.read_bytes()
    try: value=json.loads(raw)
    except ValueError: value=None
    need(isinstance(value,dict),label+' JSON','object','non-object')
    return raw,value
def strings(v): return isinstance(v,list) and all(isinstance(x,str) for x in v)
d=json.load(open(sys.argv[1]))
live_raw,r=receipt(sys.argv[2],'LIVE_CONTROLS_FILE')
consent_raw,c=receipt(sys.argv[3],'CONSENT_RECEIPT_FILE')
try:
    with tarfile.open(sys.argv[4]) as archive:
        m=archive.getmember('scripts/live-ordinary-controls.mjs')
        producer=hashlib.sha256(archive.extractfile(m).read()).hexdigest() if m.isfile() else None
except (KeyError,OSError,tarfile.TarError): producer=None
need(producer is not None,'scripts/live-ordinary-controls.mjs in BOX_ARCHIVE_PATH','regular-file','missing')
need(set(r)=={'release_sha','window_id','window','phase','controls','consent_receipt_sha256','producer_sha256','dcr_client_ids'},'live receipt keys','exact-schema-set','other-set')
for k in ('release_sha','window_id','window'): need(r[k]==d[k],'live '+k,'input-'+k.replace('_','-'),'mismatch')
need(r['phase']=='before','live phase','before',r['phase'] if r['phase'] in ('after','recovery') else 'other')
controls=('hosted_mcp_consent_refresh','dcr_registration_consent','cimd_consent','human_recovery','worker_command_read')
need(isinstance(r['controls'],dict) and set(r['controls'])==set(controls),'live control names','five-ordinary-controls','other-set')
for k in controls: need(r['controls'][k] is True,'live control '+k,'true','false' if r['controls'][k] is False else 'non-true')
need(r['consent_receipt_sha256']==hashlib.sha256(consent_raw).hexdigest(),'live consent_receipt_sha256','sha256-of-CONSENT_RECEIPT_FILE','mismatch')
need(r['producer_sha256']==producer,'live producer_sha256','sha256-of-released-script','mismatch')
need(strings(r['dcr_client_ids']),'live dcr_client_ids','list-of-strings','other')
need(set(c)=={'kind','release_sha','consent_phase','measured_at','producer_sha256','controls','dcr_client_ids','cleanup'},'consent receipt keys','exact-schema-set','other-set')
need(c['kind']=='c1-consent','consent kind','c1-consent','other')
need(c['release_sha']==d['release_sha'],'consent release_sha','input-release-sha','mismatch')
need(isinstance(c['controls'],dict) and set(c['controls'])=={'cimd_consent','dcr_registration_consent'},'consent control names','cimd-and-dcr-consent','other-set')
for k in ('cimd_consent','dcr_registration_consent'): need(c['controls'][k] is True,'consent control '+k,'true','false' if c['controls'][k] is False else 'non-true')
need(c['producer_sha256']==producer,'consent producer_sha256','sha256-of-released-script','mismatch')
need(strings(c['dcr_client_ids']),'consent dcr_client_ids','list-of-strings','other')
need(isinstance(c['measured_at'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z',c['measured_at']) is not None,'consent measured_at','UTC-ISO-8601-Z','other')
try: measured=datetime.datetime.fromisoformat(c['measured_at'].replace('Z','+00:00'))
except ValueError: measured=None
need(measured is not None,'consent measured_at','valid-UTC-time','invalid')
phase='pre-W1' if r['window'] in ('W1','W2','W2b','W3','W4') or (r['window']=='W5' and r['phase']=='before') else 'post-W5'
need(c['consent_phase']==phase,'consent_phase for '+r['window']+' '+r['phase'],phase,c['consent_phase'] if c['consent_phase'] in ('pre-W1','post-W5') else 'other')
if phase=='pre-W1':
    need(c['cleanup'] is None,'pre-W1 consent cleanup','null','non-null')
else:
    k=c['cleanup']
    need(isinstance(k,dict) and set(k)=={'grants_revoked','dcr_clients_expiring'},'post-W5 consent cleanup','object','null-or-other')
    need(k['grants_revoked'] is True,'post-W5 cleanup grants_revoked','true','non-true')
    expiring=k['dcr_clients_expiring']
    need(isinstance(expiring,list) and len(expiring)>0,'post-W5 cleanup dcr_clients_expiring','nonempty-list','other')
    for x in expiring:
        need(isinstance(x,dict) and set(x)=={'client_id','expires_after'} and isinstance(x['client_id'],str),'post-W5 cleanup dcr_clients_expiring entry','exact-client_id-and-expires_after','other')
        need(x['client_id'] not in c['dcr_client_ids'],'post-W5 cleanup dcr_clients_expiring client_id','not-own-dcr_client_id','own-id')
        need(isinstance(x['expires_after'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z',x['expires_after']) is not None,'post-W5 cleanup expires_after','UTC-ISO-8601-Z','other')
        try: until=datetime.datetime.fromisoformat(x['expires_after'].replace('Z','+00:00'))
        except ValueError: until=None
        need(until is not None and until>datetime.datetime.now(datetime.timezone.utc),'post-W5 cleanup expires_after','future','past-or-invalid')
if d['window']=='W1':
    age=(datetime.datetime.now(datetime.timezone.utc)-measured).total_seconds()
    need(age>=0,'pre-W1 consent measured_at','not-future','future')
    need(age<=21600,'pre-W1 consent measured_at age','at-most-6h','older')
PY
case "$WINDOW" in W6|W7) CONSENT_PHASE=post-W5;; *) CONSENT_PHASE=pre-W1;; esac
mkdir -p "$PROOF_DIR"
chmod 0700 "$PROOF_DIR"
install -m 0600 "$LIVE_CONTROLS_FILE" "$PROOF_DIR/ordinary-before.json"
install -m 0600 "$CONSENT_RECEIPT_FILE" "$PROOF_DIR/consent-$CONSENT_PHASE.json"
if test "$WINDOW" = W2; then
 # Pre-open refused a complete 20261003 set; capture the empty (or prefix) list close later compares.
 test ! -e "$PROOF_DIR/ledger-at-open.txt" && test ! -L "$PROOF_DIR/ledger-at-open.txt" || { printf 'FAIL ai-open: ledger-at-open.txt expected absent got present; STOP\n' >&2; exit 1; }
 : >"$PROOF_DIR/ledger-at-open.txt"
 chmod 0600 "$PROOF_DIR/ledger-at-open.txt"
fi
# Pointer in the same statement as mktemp: a crash between them cannot leave an unrecorded stage.
SECRET_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX) && printf '%s\n' "$SECRET_STAGE" >"$PROOF_DIR/secret-stage.path"
chmod 0700 "$SECRET_STAGE"
install -m 0600 "$INPUTS_FILE" "$PROOF_DIR/inputs.json"
install -m 0600 "$GATE_RECEIPT_FILE" "$PROOF_DIR/gates.json"
case "$WINDOW" in W5|W6|W7)
 test ! -e "$PROOF_DIR/edge-measurement-open.json" && test ! -L "$PROOF_DIR/edge-measurement-open.json" || { printf 'FAIL ai-open: edge-measurement-open.json expected absent got present; STOP\n' >&2; exit 1; }
 : "${EDGE_MEASUREMENT_FILE:?FAIL ai-open: EDGE_MEASUREMENT_FILE expected absolute-regular-file got unset; STOP}"
 python3 - "$EDGE_MEASUREMENT_FILE" "$PROOF_DIR/edge-measurement-open.json" <<'PY' || { printf 'FAIL ai-open: opening edge measurement expected retained-same-digest got other; STOP\n' >&2; exit 1; }
import hashlib,os,stat,sys
src,dst=sys.argv[1],sys.argv[2]
def read(path):
    try: fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError: return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        return os.read(fd,1048577)
    finally: os.close(fd)
raw=read(src)
if raw is None: raise SystemExit('FAIL ai-open: EDGE_MEASUREMENT_FILE expected regular-non-symlink got other; STOP')
fd=os.open(dst,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try: os.write(fd,raw)
finally: os.close(fd)
os.chmod(dst,0o600)
kept=read(dst)
if kept!=raw or hashlib.sha256(raw).digest()!=hashlib.sha256(kept).digest():
    raise SystemExit('FAIL ai-open: edge-measurement-open.json digest expected EDGE_MEASUREMENT_FILE digest got other; STOP')
print('PASS ai-open: opening edge measurement retained at 0600 with the same digest')
PY
;; esac
if test ! -e "$RELEASE_ROOT"; then
 mkdir -p "$RELEASE_ROOT"
 python3 - "$BOX_ARCHIVE_PATH" "$RELEASE_ROOT" <<'PY'
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]); assert root.resolve(strict=True)==root
with tarfile.open(sys.argv[1]) as archive:
    for m in archive.getmembers():
        rel=pathlib.PurePosixPath(m.name)
        assert not rel.is_absolute() and '..' not in rel.parts and (m.isfile() or m.isdir() or m.issym())
    archive.extractall(root,filter='data')
PY
 printf '%s\n' "$RELEASE_SHA" >"$RELEASE_ROOT/RELEASE_SHA"
else
 test ! -L "$RELEASE_ROOT"
 test "$(cat "$RELEASE_ROOT/RELEASE_SHA")" = "$RELEASE_SHA"
fi
# Exact archive reconciliation of all tracked files, including on reuse.
python3 - "$BOX_ARCHIVE_PATH" "$RELEASE_ROOT" <<'PY'
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[2]); assert root.resolve(strict=True)==root
with tarfile.open(sys.argv[1]) as archive:
    for m in archive.getmembers():
        p=root/m.name
        assert not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts
        if m.isfile(): assert not p.is_symlink() and p.read_bytes()==archive.extractfile(m).read(), 'FAIL archive bytes; STOP'
        elif m.issym(): assert p.is_symlink() and p.readlink().as_posix()==m.linkname
        else: assert m.isdir() and p.is_dir()
PY
OPEN_PLAN_SHA256=$(sha256sum "$RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" | awk '{print $1}')
OPEN_EXPECTED_PLAN_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["plan_sha256"])' "$INPUTS_FILE")
test "$OPEN_PLAN_SHA256" = "$OPEN_EXPECTED_PLAN_SHA256"
cp /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env"
cp /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
cp /home/commonswarm/.env "$SECRET_STAGE/edge.env"
cp /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy"
cp /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.caddy"
chmod 0600 "$SECRET_STAGE/"*
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/open.txt"
printf 'PASS ai-open: %s; secret cleanup pointer retained\n' "$WINDOW"
```

```sh
# step: ai-db-session
# readonly: no
# host: box root; task files only, database queries read-only until apply
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
test -f "$PROOF_DIR/open.txt" || { printf 'FAIL ai-db-session: open.txt expected present got missing; STOP\n' >&2; exit 1; }
test ! -e "$PROOF_DIR/closed.txt" || { printf 'FAIL ai-db-session: closed.txt expected absent got present; STOP\n' >&2; exit 1; }
MIGRATE=$RELEASE_ROOT/deploy/supabase-stack/migrate
PGSERVICE_FILE=$SECRET_STAGE/service.conf
PGPASS_FILE=$SECRET_STAGE/pass
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL
PG_SERVICE_OUTPUT="$PGSERVICE_FILE" PG_PASS_OUTPUT="$PGPASS_FILE" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "$MIGRATE/make-pg-service.mjs" >"$SECRET_STAGE/db-session.log" 2>&1
chmod 0600 "$PGSERVICE_FILE" "$PGPASS_FILE"
EDGE_RECYCLE_SERVICE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_service"])' "$INPUTS_FILE")
EDGE_RECYCLE_TIMER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_timer"])' "$INPUTS_FILE")
PSQL_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_postgres_image"])' "$INPUTS_FILE")
# docker run has no -i here (it must not swallow the driver's stdin), so a container never sees stdin: SQL sent on
# stdin is silently skipped and psql exits 0. ai_db and ai_ro therefore accept ONLY the plan's own exact grammar and
# refuse everything else before docker runs (exit 2): options -q or -Atq; --command <sql>; --file <path>, the path a
# plain .sql file under the read-only /proof or /release mounts (never -, /dev/stdin, /dev/fd/*, /proc/*, a cluster of
# short options, an abbreviation or an = form); and at least one --command or --file from the caller.
ai_db_grammar() { # caller arguments
 local sql=0
 while test $# -gt 0; do
  case "$1" in
   -q|-Atq) shift ;;
   --command) test $# -ge 2 && test -n "$2" || return 1; sql=1; shift 2 ;;
   --file) test $# -ge 2 || return 1
    [[ "$2" =~ ^/(proof|release)(/[A-Za-z0-9][A-Za-z0-9_.-]*)+\.sql$ ]] || return 1
    sql=1; shift 2 ;;
   *) return 1 ;;
  esac
 done
 test "$sql" = 1
}
ai_db() {
 ai_db_grammar "$@" || { printf 'FAIL ai_db: arguments expected the plan grammar (-q|-Atq, --command SQL, --file /proof-or-/release .sql) got other; SQL on stdin is never used (docker run has no -i); STOP\n' >&2; return 2; }
 docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
  --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$PGSERVICE_FILE:/run/service.conf:ro" --volume "$PGPASS_FILE:/run/pass:ro" \
  --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
  --volume "$RELEASE_ROOT:/release:ro" --volume "$PROOF_DIR:/proof:ro" \
  --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 "$@" 2>"$SECRET_STAGE/psql.log"
}
ai_ro() {
 ai_db_grammar "$@" || { printf 'FAIL ai_ro: arguments expected the plan grammar (-q|-Atq, --command SQL, --file /proof-or-/release .sql) got other; SQL on stdin is never used (docker run has no -i); STOP\n' >&2; return 2; }
 ai_db --command 'SET default_transaction_read_only=on;' "$@"
}
# Secret SQL: a 0600 regular file owned by this user, resolved (no symlink in its path) inside the resolved
# SECRET_STAGE, mounted read-only and run with --file; never stdin, argv or env. The session first turns off
# statement logging and error-statement logging (nonsecret --command), so a failing statement is never logged.
ai_db_secret_file() { # file
 local real
 real=$(python3 -c '
import os,stat,sys
f,stage=sys.argv[1],sys.argv[2]
real=os.path.realpath(f); root=os.path.realpath(stage)
st=os.lstat(f)
ok=(os.path.isabs(f) and os.path.normpath(f)==f and real==f and real.startswith(root+"/") and stat.S_ISREG(st.st_mode)
    and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o600 and st.st_size>0)
print(real if ok else "")
' "$1" "$SECRET_STAGE" 2>/dev/null) || real=
 test -n "$real" || { printf 'FAIL ai_db_secret_file: SQL file expected non-empty 0600 regular file of this user resolved inside SECRET_STAGE got other; STOP\n' >&2; return 2; }
 docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
  --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
  --volume "$PGSERVICE_FILE:/run/service.conf:ro" --volume "$PGPASS_FILE:/run/pass:ro" \
  --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
  --volume "$real:/run/secret.sql:ro" \
  --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 -Atq \
  --command 'SET log_statement=none; SET log_min_error_statement=panic;' --file /run/secret.sql 2>"$SECRET_STAGE/psql.log"
}
python3 - "$MIGRATE/lib.sh" "$PROOF_DIR/identity.sql" <<'PY'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
part=source.split('assert_target_identity() {\n',1)[1].split('\nassert_backup_ro_identity()',1)[0]
sql=part.split("<<'SQL'\n",1)[1].split('\nSQL',1)[0]
assert "current_user <> 'supabase_admin'" in sql and 'rolsuper' in sql
pathlib.Path(sys.argv[2]).write_text(sql+'\n')
PY
ai_ro -q --file /proof/identity.sql >/dev/null || { printf 'FAIL ai-db-session: identity.sql expected success got failure; STOP\n' >&2; exit 1; }
if test -f "$PROOF_DIR/ledger-before.txt" && test ! -L "$PROOF_DIR/ledger-before.txt"; then
 test ! -e "$PROOF_DIR/ledger-at-recovery.txt" && test ! -L "$PROOF_DIR/ledger-at-recovery.txt" || { printf 'FAIL ai-db-session: ledger-at-recovery.txt expected absent got present; STOP\n' >&2; exit 1; }
 LEDGER_SHA256=$(sha256sum "$PROOF_DIR/ledger-before.txt" | awk '{print $1}')
 EXPECTED_LEDGER_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_ledger_sha256"])' "$INPUTS_FILE")
 test "$LEDGER_SHA256" = "$EXPECTED_LEDGER_SHA256" || { printf 'FAIL ai-db-session: ledger-before.txt digest expected inputs baseline_ledger_sha256 got other; STOP\n' >&2; exit 1; }
 ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-at-recovery.txt" || { printf 'FAIL ai-db-session: ledger-at-recovery expected readable got failure; STOP\n' >&2; exit 1; }
 chmod 0600 "$PROOF_DIR/ledger-at-recovery.txt"
 python3 - "$PROOF_DIR" "$RELEASE_ROOT" <<'PY' || exit 1
import json,pathlib,sys
p,root=map(pathlib.Path,sys.argv[1:3]); planned=['2026100300000'+str(i) for i in range(1,6)]
if any(len(list((root/'supabase/migrations').glob(v+'_*.sql')))!=1 for v in planned): raise SystemExit('FAIL ai-db-session: expected-migration-manifest expected the release 20261003 sequence got other; STOP')
before=(p/'ledger-before.txt').read_text().splitlines(); live=(p/'ledger-at-recovery.txt').read_text().splitlines(); expected=[]; seen=False
newf,expf=p/'new-migrations.json',p/'expected-migrations.json'
if newf.is_file() and not newf.is_symlink():
    expected=[r['version'] for r in json.loads(newf.read_text())]; seen=True
elif expf.is_file() and not expf.is_symlink():
    data=json.loads(expf.read_text()); expected=[v for v in planned if v in data]; seen=True
    if any(str(k).startswith('20261003') and k not in planned for k in data): expected=['*']
if seen and expected!=planned: raise SystemExit('FAIL ai-db-session: expected-migration-manifest expected the release 20261003 sequence got other; STOP')
added=live[len(before):]
if live[:len(before)]!=before or added!=expected[:len(added)]: raise SystemExit('FAIL ai-db-session: ledger-at-recovery.txt expected ledger-before-plus-ordered-prefix-of-new-migrations got other; STOP')
PY
else
 test ! -e "$PROOF_DIR/ledger-before.txt" && test ! -L "$PROOF_DIR/ledger-before.txt" || { printf 'FAIL ai-db-session: ledger-before.txt expected absent-or-regular got other; STOP\n' >&2; exit 1; }
 ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-before.txt" || { printf 'FAIL ai-db-session: ledger-before expected readable got failure; STOP\n' >&2; exit 1; }
 LEDGER_SHA256=$(sha256sum "$PROOF_DIR/ledger-before.txt" | awk '{print $1}')
 EXPECTED_LEDGER_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_ledger_sha256"])' "$INPUTS_FILE")
 test "$LEDGER_SHA256" = "$EXPECTED_LEDGER_SHA256" || { printf 'FAIL ai-db-session: ledger-before.txt digest expected inputs baseline_ledger_sha256 got other; STOP\n' >&2; exit 1; }
fi
ai_run() {
 local STEP_NAME=$1
 # A failure BEFORE the block runs (allowlist, plan verification, lookup, syntax) is 2: it confirms nothing, so it
 # can never read as a status-contract block's confirmed-CLOSED 1.
 case "$STEP_NAME" in ai-release-aside|ai-w6-issuer-live|ai-w6-readiness|ai-w6-activation-probes|ai-w6-finish|ai-inputs|ai-gates|ai-gates-bind|ai-w6-activation-approval|ai-w7-approval|ai-w7-preflight|ai-recycle-install|ai-recycle-rollback|ai-timer-guard|ai-w4-timer-recovery|ai-w6-activation-rollback|ai-emergency-close|ai-w2-measure|ai-w2-between-probes|ai-w2-reconcile|ai-w2-backfill|ai-w2-revoke-probes|ai-w2b-proof-check|ai-backup-gate-check|ai-w2-issuer-rollback|ai-edge-remeasure|ai-w6-audit|ai-w6-closed-gate-probe) ;; *) printf 'FAIL ai_run: step %s expected allowlisted got unsupported; STOP\n' "$STEP_NAME" >&2; return 2;; esac
 local AI_RUN_SOURCE
 # The verified block reaches the shell only through this substitution: no staged path.
 AI_RUN_SOURCE=$(python3 -c '
import hashlib,json,os,re,stat,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b"".join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get("plan_sha256"):
        raise SystemExit("FAIL "+step+": released RELEASE.md expected absolute-regular-file-with-input-plan_sha256 got "+("missing-or-not-regular" if raw is None else "digest-mismatch")+"; STOP")
    return raw
blocks=re.findall(r"^`{3}sh\n(.*?)^`{3}$",verified_plan(sys.argv[1],sys.argv[3],"ai_run").decode(),re.M|re.S)
found=[b for b in blocks if b.startswith("# step: "+sys.argv[2]+"\n")]
if len(found)!=1: raise SystemExit("FAIL ai_run: block "+sys.argv[2]+" expected one got "+str(len(found))+"; STOP")
sys.stdout.write(found[0])
' "$RELEASE_ROOT/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md" "$STEP_NAME" "$INPUTS_FILE") || return 2
 printf '%s\n' "$AI_RUN_SOURCE" | /bin/bash -n || return 2
 eval "$AI_RUN_SOURCE"
}
ai_deadline() {
 test ! -e "$PROOF_DIR/closed.txt" || { printf 'FAIL ai-db-session: closed.txt expected absent got present; STOP\n' >&2; exit 1; }
 python3 - "$INPUTS_FILE" <<'PY'
import datetime,json,sys
end=datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))['window_end_utc'].replace('Z','+00:00'))
assert datetime.datetime.now(datetime.timezone.utc)<end, 'FAIL window expired; STOP'
PY
}
if test "$WINDOW" = W2; then
 if test -f "$PROOF_DIR/ledger-at-open.txt" && test ! -L "$PROOF_DIR/ledger-at-open.txt"; then
  :
 else
  test ! -e "$PROOF_DIR/ledger-at-open.txt" && test ! -L "$PROOF_DIR/ledger-at-open.txt" || { printf 'FAIL ai-db-session: ledger-at-open.txt expected absent-or-regular got other; STOP\n' >&2; exit 1; }
  ai_ro -Atq --command "SELECT version FROM supabase_migrations.schema_migrations WHERE version LIKE '20261003%' ORDER BY version;" >"$PROOF_DIR/ledger-at-open.txt" || { printf 'FAIL ai-db-session: W2 ledger-at-open expected readable got failure; STOP\n' >&2; exit 1; }
  chmod 0600 "$PROOF_DIR/ledger-at-open.txt"
 fi
fi
printf 'PASS ai-db-session: target identity and exact ledger baseline'
```

```sh
# step: ai-gates
# readonly: yes
# host: Mac or box; private evidence files are NOT accepted
set -euo pipefail
: "${INPUTS_FILE:?}" "${GATE_RECEIPT_FILE:?}" "${PLAN_FILE:?}"
python3 - "$INPUTS_FILE" "$GATE_RECEIPT_FILE" "$PLAN_FILE" <<'PY'
import hashlib,json,pathlib,sys
d=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
contract=json.loads((pathlib.Path(sys.argv[3]).parent/'GATES.json').read_text())
def need(ok,reason):
    if not ok: raise SystemExit('FAIL ai-gates: '+reason+'; STOP')
need(set(r)=={'release_sha','gates','evidence_root'} and r['release_sha']==d['release_sha'],'same-build receipt')
root=pathlib.Path(r['evidence_root']); need(root.is_absolute() and root.is_dir() and not root.is_symlink(),'evidence root')
required=contract['windows'][d['window']]
for name in required:
    g=r['gates'].get(name)
    need(isinstance(g,dict) and set(g)=={'status','controls','file','sha256'} and g['status']=='PASS',name+' PASS')
    need(g['controls']==contract['gates'][name],name+' positive/negative controls')
    rel=pathlib.PurePosixPath(g['file'])
    need(not rel.is_absolute() and '..' not in rel.parts and bool(rel.parts),name+' relative file')
    p=root/rel
    need(p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(root.resolve()),name+' evidence file')
    need(hashlib.sha256(p.read_bytes()).hexdigest()==g['sha256'],name+' evidence digest')
print('PASS ai-gates: required same-build controls and retained evidence')
PY
```

```sh
# step: ai-gates-bind
# readonly: yes
# host: box root; Mac already ran ai-gates; bind GATE_RECEIPT_FILE and $PROOF_DIR/gates.json digest; do not open evidence_root
set -euo pipefail
: "${INPUTS_FILE:?}" "${GATE_RECEIPT_FILE:?}" "${PLAN_FILE:?}" "${PROOF_DIR:?}"
python3 - "$INPUTS_FILE" "$GATE_RECEIPT_FILE" "$PLAN_FILE" "$PROOF_DIR" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-gates-bind: '+what+' expected '+expected+' got '+got+'; STOP')
def read_regular(path):
    try: fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError: return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        return os.read(fd,1048577)
    finally: os.close(fd)
d=json.load(open(sys.argv[1])); want=d.get('gate_receipt_sha256')
need(isinstance(want,str) and re.fullmatch('[0-9a-f]{64}',want) is not None,'gate_receipt_sha256','64-lowercase-hex','other')
def digest_of(path,label):
    raw=read_regular(path)
    need(raw is not None,label,'regular-non-symlink','missing-or-not-regular')
    need(len(raw)<=1048576,label,'at-most-1MiB','too-large')
    need(hashlib.sha256(raw).hexdigest()==want,label+' digest','input-gate_receipt_sha256','mismatch')
    return raw
raw=digest_of(sys.argv[2],'GATE_RECEIPT_FILE')
digest_of(pathlib.Path(sys.argv[4])/'gates.json','PROOF_DIR/gates.json')
try: r=json.loads(raw)
except ValueError: r=None
need(isinstance(r,dict) and set(r)=={'release_sha','gates','evidence_root'},'receipt keys','release_sha-gates-evidence_root','other')
need(r['release_sha']==d['release_sha'],'receipt release_sha','input-release-sha','mismatch')
contract=json.loads((pathlib.Path(sys.argv[3]).parent/'GATES.json').read_text())
need(d.get('window') in contract.get('windows',{}),'window','GATES.json-window','missing-or-other')
need(isinstance(r.get('gates'),dict),'receipt gates','object','other')
for name in contract['windows'][d['window']]:
    g=r['gates'].get(name)
    need(isinstance(g,dict) and set(g)=={'status','controls','file','sha256'} and g['status']=='PASS',name+' status','PASS-with-controls-file-sha256','other')
    need(g['controls']==contract['gates'][name],name+' controls','GATES.json-controls','mismatch')
print('PASS ai-gates-bind: receipt digest, same-build release_sha and required gate list; evidence files not opened')
PY
```

```sh
# step: ai-ordinary-probes
# readonly: probe
# host: Mac outside ingress; run before open and after every window/recovery
set -euo pipefail
python3 - <<'PY'
import json,urllib.error,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
checks=[('https://mcp.commonswarm.com/health','GET',None,200),
 ('https://mcp.commonswarm.com/.well-known/oauth-authorization-server','GET',None,200),
 ('https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp','GET',None,200),
 ('https://mcp.commonswarm.com/mcp','POST',b'{}',401),
 ('https://api.commonswarm.com/auth/v1/health','GET',None,200),
 ('https://commonswarm.com/app/','GET',None,200)]
for index,(url,method,data,expected) in enumerate(checks):
    req=urllib.request.Request(url,method=method,data=data,headers={'User-Agent':'curl/8.7.1','Content-Type':'application/json'})
    try: response=opener.open(req,timeout=15)
    except urllib.error.HTTPError as error: response=error
    with response:
        body=response.read(1048577)
        assert len(body)<=1048576 and response.status==expected, 'FAIL ordinary route '+str(index)+'; STOP'
print('PASS ordinary route probes; authenticated path evidence is separately required')
PY
```

Authenticated ordinary hosted MCP consent/refresh, DCR registration/consent,
CIMD metadata/consent, fresh human recovery and worker command/read probes are
required in `ordinary-paths-unchanged` (GATES.json). Anonymous 401 alone proves
no authenticated behavior. W1/W2/W3/W4 forward close refuses without a fresh
window-bound live ordinary receipt via ai-live-controls.

The producer is `scripts/live-ordinary-controls.mjs` from this RELEASE_SHA. A
dedicated controls worker started by HezLead's chain runs it; that worker reads
credentials only from 0600 files and is never the read-only preparation worker.
Its consent legs run twice per release: once before W1 opens (`pre-W1`) and
once after W5's site release and before W5's forward close (`post-W5`). Each consent click goes only through the
pointer-file handoff to HezLead's consent worker; the script writes the
authorize URL to a 0600 pointer file, waits for the callback file and never
opens a browser. Its non-consent legs run before and after every window and
produce LIVE_CONTROLS_FILE. Its only writes are recorded DCR registrations, a
refresh of its own test grant and one note per run to workspace
"c1-controls (test)". The pre-W1 run's CIMD grant serves the W1–W5 refresh
legs. The post-W5 run obtains a new CIMD grant for the W5-after, W6 and W7
legs. Its cleanup revokes the pre-W1 grant family, proven by a rejected refresh,
and lists every DCR client recorded by the pre-W1 run and by the window runs up
to W5 before, but not its own new clients, with each client's expiry time. The
issuer has no DCR deletion route and the plan makes no production deletes: DCR
test clients are left to expire after 30 days unused (token use renews them).
After W7 (or the last window run), HezLead's chain runs the producer's final
cleanup, which revokes the post-W5 grant family and writes a 0600 report of
every remaining DCR client and its expiry; it is not a plan receipt.
ai-open and ai-live-controls bind every live receipt to its consent receipt and
both to the producer bytes released in this archive. Both read the producer
from the release archive after checking its archive_sha256, never from an
extracted tree. ai-live-controls is the single validator: W2–W4 preflight and
ai-close re-run it on the retained copies (schema, binding, digests, producer,
phase and cleanup), and W5 runs it on the Mac against `$PREP_DIR/release.tar`.
Without both receipts, STOP before the window opens.

```sh
# step: ai-live-controls
# readonly: yes
# host: box (or the W5 Mac shell); read independently produced, nonsecret window probes
set -euo pipefail
: "${LIVE_CONTROLS_FILE:?FAIL ai-live-controls: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP}"
: "${CONSENT_RECEIPT_FILE:?FAIL ai-live-controls: CONSENT_RECEIPT_FILE expected absolute-regular-file got unset; STOP}"
: "${BOX_ARCHIVE_PATH:?FAIL ai-live-controls: BOX_ARCHIVE_PATH expected open-shell-variable got unset; STOP}"
: "${PROOF_DIR:?FAIL ai-live-controls: PROOF_DIR expected open-shell-variable got unset; STOP}"
# The single receipt validator. ai-open's later consumers and W5 run this exact
# block on retained copies (LIVE_CONTROLS_EXPECT_PHASE set, LIVE_CONTROLS_RETAIN=no).
# Producer bytes come from the release archive, re-verified against archive_sha256
# here, never from an extracted tree.
python3 - "$INPUTS_FILE" "$LIVE_CONTROLS_FILE" "$CONSENT_RECEIPT_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "${LIVE_CONTROLS_EXPECT_PHASE:-}" "${LIVE_CONTROLS_RETAIN:-yes}" <<'PY'
import datetime,hashlib,io,json,pathlib,re,sys,tarfile
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-live-controls: '+what+' expected '+expected+' got '+got+'; STOP')
def receipt(name,label):
    p=pathlib.Path(name)
    need(p.is_absolute() and p.is_file() and not p.is_symlink(),label,'absolute-regular-file','missing-or-not-regular')
    raw=p.read_bytes()
    try: value=json.loads(raw)
    except ValueError: value=None
    need(isinstance(value,dict),label+' JSON','object','non-object')
    return raw,value
def strings(v): return isinstance(v,list) and all(isinstance(x,str) for x in v)
d=json.load(open(sys.argv[1]))
live_raw,r=receipt(sys.argv[2],'LIVE_CONTROLS_FILE')
consent_raw,c=receipt(sys.argv[3],'CONSENT_RECEIPT_FILE')
expect,retain=sys.argv[6],sys.argv[7]
need(expect in ('','before','after','recovery') and retain in ('yes','no'),'LIVE_CONTROLS_EXPECT_PHASE/LIVE_CONTROLS_RETAIN','phase-or-empty/yes-or-no','other')
archive=pathlib.Path(sys.argv[4])
need(archive.is_absolute() and archive.is_file() and not archive.is_symlink(),'BOX_ARCHIVE_PATH','absolute-regular-file','missing-or-not-regular')
archive_raw=archive.read_bytes()
need(hashlib.sha256(archive_raw).hexdigest()==d.get('archive_sha256'),'BOX_ARCHIVE_PATH bytes','input-archive_sha256','mismatch')
try:
    with tarfile.open(fileobj=io.BytesIO(archive_raw)) as tar:
        m=tar.getmember('scripts/live-ordinary-controls.mjs')
        producer=hashlib.sha256(tar.extractfile(m).read()).hexdigest() if m.isfile() else None
except (KeyError,OSError,tarfile.TarError): producer=None
need(producer is not None,'scripts/live-ordinary-controls.mjs in BOX_ARCHIVE_PATH','regular-file','missing')
need(set(r)=={'release_sha','window_id','window','phase','controls','consent_receipt_sha256','producer_sha256','dcr_client_ids'},'live receipt keys','exact-schema-set','other-set')
for k in ('release_sha','window_id','window'): need(r[k]==d[k],'live '+k,'input-'+k.replace('_','-'),'mismatch')
need(r['phase'] in ('before','after','recovery'),'live phase','before-after-or-recovery','other')
if expect: need(r['phase']==expect,'live phase',expect,r['phase'])
controls=('hosted_mcp_consent_refresh','dcr_registration_consent','cimd_consent','human_recovery','worker_command_read')
need(isinstance(r['controls'],dict) and set(r['controls'])==set(controls),'live control names','five-ordinary-controls','other-set')
for k in controls: need(r['controls'][k] is True,'live control '+k,'true','false' if r['controls'][k] is False else 'non-true')
need(r['consent_receipt_sha256']==hashlib.sha256(consent_raw).hexdigest(),'live consent_receipt_sha256','sha256-of-CONSENT_RECEIPT_FILE','mismatch')
need(r['producer_sha256']==producer,'live producer_sha256','sha256-of-released-script','mismatch')
need(strings(r['dcr_client_ids']),'live dcr_client_ids','list-of-strings','other')
need(set(c)=={'kind','release_sha','consent_phase','measured_at','producer_sha256','controls','dcr_client_ids','cleanup'},'consent receipt keys','exact-schema-set','other-set')
need(c['kind']=='c1-consent','consent kind','c1-consent','other')
need(c['release_sha']==d['release_sha'],'consent release_sha','input-release-sha','mismatch')
need(isinstance(c['controls'],dict) and set(c['controls'])=={'cimd_consent','dcr_registration_consent'},'consent control names','cimd-and-dcr-consent','other-set')
for k in ('cimd_consent','dcr_registration_consent'): need(c['controls'][k] is True,'consent control '+k,'true','false' if c['controls'][k] is False else 'non-true')
need(c['producer_sha256']==producer,'consent producer_sha256','sha256-of-released-script','mismatch')
need(strings(c['dcr_client_ids']),'consent dcr_client_ids','list-of-strings','other')
need(isinstance(c['measured_at'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z',c['measured_at']) is not None,'consent measured_at','UTC-ISO-8601-Z','other')
try: measured=datetime.datetime.fromisoformat(c['measured_at'].replace('Z','+00:00'))
except ValueError: measured=None
need(measured is not None,'consent measured_at','valid-UTC-time','invalid')
phase='pre-W1' if r['window'] in ('W1','W2','W2b','W3','W4') or (r['window']=='W5' and r['phase']=='before') else 'post-W5'
need(c['consent_phase']==phase,'consent_phase for '+r['window']+' '+r['phase'],phase,c['consent_phase'] if c['consent_phase'] in ('pre-W1','post-W5') else 'other')
if phase=='pre-W1':
    need(c['cleanup'] is None,'pre-W1 consent cleanup','null','non-null')
else:
    k=c['cleanup']
    need(isinstance(k,dict) and set(k)=={'grants_revoked','dcr_clients_expiring'},'post-W5 consent cleanup','object','null-or-other')
    need(k['grants_revoked'] is True,'post-W5 cleanup grants_revoked','true','non-true')
    expiring=k['dcr_clients_expiring']
    need(isinstance(expiring,list) and len(expiring)>0,'post-W5 cleanup dcr_clients_expiring','nonempty-list','other')
    for x in expiring:
        need(isinstance(x,dict) and set(x)=={'client_id','expires_after'} and isinstance(x['client_id'],str),'post-W5 cleanup dcr_clients_expiring entry','exact-client_id-and-expires_after','other')
        need(x['client_id'] not in c['dcr_client_ids'],'post-W5 cleanup dcr_clients_expiring client_id','not-own-dcr_client_id','own-id')
        need(isinstance(x['expires_after'],str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z',x['expires_after']) is not None,'post-W5 cleanup expires_after','UTC-ISO-8601-Z','other')
        try: until=datetime.datetime.fromisoformat(x['expires_after'].replace('Z','+00:00'))
        except ValueError: until=None
        need(until is not None and until>datetime.datetime.now(datetime.timezone.utc),'post-W5 cleanup expires_after','future','past-or-invalid')
if retain=='yes':
    proof=pathlib.Path(sys.argv[5])
    copies=[(proof/('consent-'+phase+'.json'),consent_raw),(proof/('ordinary-'+r['phase']+'.json'),live_raw)]
    for copy,raw in copies: need(not copy.exists() or copy.read_bytes()==raw,'retained '+copy.name,'absent-or-identical','different-bytes')
    for copy,raw in copies: copy.write_bytes(raw)
print('PASS live authenticated ordinary controls bound to consent '+phase+' and released producer')
PY
```

Before an admin box window opens, ai-open itself validates live controls and
consent. Standalone ai-live-controls runs after ai-open has created PROOF_DIR.
Before a W5 open, ai-w5-preflight also runs the full ai-live-controls block
with PROOF_DIR=$PREP_DIR/w5-live-before and the pre-W1 consent receipt.
HezLead supplies the controls worker's LIVE_CONTROLS_FILE before open and after
each window, together with the CONSENT_RECEIPT_FILE it is bound to: `pre-W1`
for W1–W4, W2b and W5 before, `post-W5` for W5 after/recovery, W6 and W7. This plan
only validates that external input and retains `ordinary-<phase>.json` and
`consent-<consent_phase>.json` in PROOF_DIR; no operator-authored probe is
permitted during the release window.

## W1: fresh backup gate

HezLead takes a fresh verified database/object backup before W1. The existing
isolated restore drill must have a complete successful receipt; no live restore
or service dispatch is authorized here. W2 consumes this exact W1 close.
The same block is W2b's and W4's backup gate (HezLead ruling): it runs right
after their common open/session, as in W1, and their success close requires its
backup-gate.json. W1 is not rerun at a later release.

```sh
# step: ai-w1-backup-gate
# readonly: no
# host: HezLead box root; status reads and nonsecret proof only; W1, W2b and W4
set -euo pipefail
case "$WINDOW" in W1|W2b|W4) ;; *) printf 'FAIL ai-w1-backup-gate: window expected W1-W2b-or-W4 got other; STOP\n' >&2; exit 1;; esac
ai_deadline
python3 - "$PROOF_DIR/backup-gate.json" "$INPUTS_FILE" "$WINDOW" <<'PY'
import datetime,json,pathlib,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
now=datetime.datetime.now(datetime.timezone.utc)
try:
    b=json.load(open('/var/backups/commonswarm-postgres/status.json'))
    r=json.load(open('/var/backups/commonswarm-postgres/restore-status.json'))
except (OSError,ValueError): raise SystemExit('FAIL backup and restore status files; STOP') from None
assert all(b.get(k) is True for k in ('ok','database_bytes_verified','object_bytes_verified')), 'FAIL verified backup; STOP'
verified=box_utc(b.get('verified_at')); assert verified is not None, 'FAIL backup verified_at expected aware-UTC-ISO-8601-time got other; STOP'
age=(now-verified).total_seconds()
assert 0<=age<=1800 and b['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/'), 'FAIL fresh backup; STOP'
assert r.get('ok') is True and r.get('state')=='complete', 'FAIL complete restore drill; STOP'
restored=box_utc(r.get('at')); assert restored is not None, 'FAIL restore at expected aware-UTC-ISO-8601-time got other; STOP'
age=(now-restored).total_seconds()
assert 0<=age<=8*86400, 'FAIL restore freshness; STOP'
d=json.load(open(sys.argv[2])); assert d['window']==sys.argv[3], 'FAIL backup gate window binding; STOP'
# A bound receipt: release, window and window ID, the measured times (the box strings as written, +00:00 with
# microseconds), the destination and the gate time (written ...Z with 6 digits); ai-backup-gate-check reads all
# three with the same box_utc parser.
pathlib.Path(sys.argv[1]).write_text(json.dumps({'status':'PASS','release_sha':d['release_sha'],'window':d['window'],'window_id':d['window_id'],
    'backup_verified_at':b['verified_at'],'restore_completed_at':r['at'],'destination':b['destination'],
    'gate_at':now.strftime('%Y-%m-%dT%H:%M:%S.%fZ')},sort_keys=True)+'\n')
PY
BACKUP_GATE_DIR="$PROOF_DIR"
ai_run ai-backup-gate-check
```

Every consumer of a backup-gate.json (W2 preflight for W1, W2b preflight and
issuer credential, W4 preflight and apply, and the W1/W2b/W4 success close)
validates it with this ONE block, never by file presence: exact keys, every
time read with the shared strict `box_utc` parser (an aware UTC time with
offset `+00:00` or `Z` and 0-6 fraction digits, as the box backup writer
emits, e.g. `2026-10-04T22:12:09.199316+00:00`; any other offset, a naive time
or a non-ISO value is refused), the
receipt bound to its own window directory's inputs.json (release, window,
window ID), the backup verified at most 1800 s and the restore drill completed
at most 8 days before the gate time, the gate time inside that window
(open.txt <= gate_at < window_end_utc, and not in the future) and the reviewed
backup destination.

```sh
# step: ai-backup-gate-check
# readonly: yes
# host: box root; run through ai_run by every backup-gate consumer with BACKUP_GATE_DIR set to that window's proof directory
set -euo pipefail
: "${BACKUP_GATE_DIR:?FAIL ai-backup-gate-check: BACKUP_GATE_DIR expected window-proof-directory got unset; STOP}"
python3 - "$BACKUP_GATE_DIR" <<'PY'
import datetime,json,os,pathlib,re,stat,sys
w=pathlib.Path(sys.argv[1])
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-backup-gate-check: '+what+' expected '+expected+' got '+got+'; STOP')
def read(name):
    try: fd=os.open(str(w/name),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError: return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        return os.read(fd,65537)
    finally: os.close(fd)
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
def when(value,what):
    t=box_utc(value); need(t is not None,what,'aware-UTC-ISO-8601-time','other'); return t
need(w.is_absolute() and w.is_dir() and not w.is_symlink(),'backup gate directory','absolute-directory','missing-or-symlink')
raw=read('backup-gate.json'); need(raw is not None and len(raw)<=65536,'backup-gate.json','regular-file','missing-or-not-regular')
try: g=json.loads(raw)
except ValueError: g=None
need(isinstance(g,dict),'backup-gate.json','JSON-object','malformed')
need(set(g)=={'status','release_sha','window','window_id','backup_verified_at','restore_completed_at','destination','gate_at'} and g['status']=='PASS','backup-gate.json keys','exact-PASS-receipt','other')
try: i=json.loads(read('inputs.json') or b'')
except ValueError: i=None
need(isinstance(i,dict),'window inputs.json','JSON-object','missing-or-malformed')
need(g['window'] in ('W1','W2b','W4') and all(g[k]==i.get(k) for k in ('release_sha','window','window_id')),'backup-gate.json binding','same-release-window-and-window-id-as-inputs','other')
gate=when(g['gate_at'],'gate_at'); backup=when(g['backup_verified_at'],'backup_verified_at'); restore=when(g['restore_completed_at'],'restore_completed_at')
need(0<=(gate-backup).total_seconds()<=1800,'backup verified_at at gate time','at-most-1800s-old','stale-or-future')
need(0<=(gate-restore).total_seconds()<=8*86400,'restore drill completed_at at gate time','at-most-8-days-old','stale-or-future')
need(isinstance(g['destination'],str) and g['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/'),'backup destination','reviewed-r2-prefix','other')
opened=read('open.txt'); need(opened is not None,'window open.txt','regular-file','missing')
start=when(opened.decode(errors='replace').strip(),'open.txt')
end=when(i.get('window_end_utc'),'window inputs window_end_utc')
need(start<=gate<end and gate<=datetime.datetime.now(datetime.timezone.utc),'gate_at','inside-this-window','before-open-after-end-or-future')
print('PASS ai-backup-gate-check: '+g['window']+' '+g['window_id']+' backup and restore fresh at gate '+g['gate_at'])
PY
```

## W2: one schema window before any code release

HezLead's lane 8 W2 split ruling authorizes unchanged M1, M2 and M3 in
separate transactions, each with its ledger row. M4 creates the checksum table
in its own transaction, inserts its ledger/checksum and backfills M1–M3 plus
EVERY previously applied ledger version. M5 commits its ledger and checksum in
its own transaction. M1–M3 checksums are source=backfill at RELEASE_SHA;
historical backfills retain their actual released_sha after byte equality with
RELEASE_SHA is verified; `ledger-statements` and `attested-baseline` rows are
recorded at RELEASE_SHA and their provenance stays in `backfill-evidence.json`
(see BACKFILL_FILE). No migration or reserve SQL is edited.

Before M1, ai-w2-measure counts rows and pg_total_relation_size (including
indexes/TOAST) of every live table locked by M1–M5 and the release ledger.
Missing tables, slow counts, rows OR bytes above a bound refuse before apply.
Bounds (MiB = 1024² bytes) are conservative admission limits, not live measurements:

| Table | Refuse above rows | Refuse above MiB | Used by |
| --- | ---: | ---: | --- |
| commonswarm_oauth.interactions | 100000 | 256 | M1 |
| swarm.admin_grants | 100000 | 128 | M1, M3 |
| swarm.hosted_mcp_grants | 100000 | 256 | M1 |
| commonswarm_oauth.provider_artifacts | 1000000 | 1024 | M1 |
| swarm.users | 100000 | 128 | M1 |
| swarm.admin_accounts | 100000 | 128 | M1, M2, M3 |
| swarm.admin_consents | 200000 | 256 | M1 |
| swarm.admin_events | 1000000 | 1024 | M2, M3 |
| swarm.admin_credentials | 100000 | 128 | M3 |
| commonswarm_oauth.refresh_family_tombstones | 1000000 | 256 | M3 |
| supabase_migrations.schema_migrations | 10000 | 16 | every ledger insert; M4 reader |

M1 takes ACCESS EXCLUSIVE on admin_grants/interactions for CHECK validation:
reads AND writes wait until commit. Trigger/FK targets take SHARE ROW EXCLUSIVE:
writes wait; SELECT proceeds. M2/M3 additionally lock the new, not-yet-live
M1/M2 admin tables. M4 locks its new checksum table. M5 replaces a read function;
its body does not execute during CREATE. The ledger is locked EXCLUSIVE to
serialize migration writers; SELECT proceeds. Inline CHECK validation stays
unchanged and is not split out of M1.

Expected lock hold, conditional on the above limits: M1 <=30s, M2/M3 <=15s,
M4/M5 <=10s (planning estimates; no measured validation duration is claimed).
Each transaction uses lock_timeout='3s'. statement_timeout is calculated from
measured rows/bytes/count duration: max(expected hold, 15 + ceil(rows/10000)
+ ceil(bytes/32MiB) + ceil(count_seconds)), capped at 60s. PG17
transaction_timeout uses the same cap for the WHOLE transaction, including
lock acquisition and COMMIT: statement_timeout alone is per statement.
Actual apply wall durations are retained. If a measured hold exceeds the
estimate, STOP before the next migration; retain the commit and reconcile.
Under the transaction locks, sizes/counts are checked again against the same
bounds to refuse growth between preflight and apply. Probes run after every
commit, before any following transaction: public ordinary MCP discovery and
health, authenticated ordinary MCP initialize (token health), and human
pending_access read. Failure stops immediately, with no later migration.

Mid-sequence failure: STOP; committed migrations and ledger rows stay. After
M4 their exact checksum/backfill rows stay too. Issuance remains OFF. A durable
apply-started marker refuses ALL reruns, including a failure before M1. The
read-only ai-w2-reconcile works even when M4/table is absent and reports the
exact prefix from the ledger, not the client exit status. An uncertain COMMIT
is reconciled there; inconsistent ledger/checksums refuse. Completion receipts
are written only for all five. Keep every verbatim per-migration reserve;
use one only in a separately approved data-free context whose refusal checks
pass. M4 refuses checksum evidence; M1 refuses provider artifacts/bindings.
Never erase ordinary or historical data to pass a reserve. No automatic or
post-COMMIT production schema rollback is authorized.

Between-probe credentials (binding probe contract, lead and release owner,
2026-10-04). MCP access tokens live 300 s and refresh tokens rotate, and the
probes run inside ai-w2-apply after its no-rerun fence, so no staged access
token is used. The producer (`scripts/live-ordinary-controls.mjs
probe-credentials`) hands off a DEDICATED DCR grant (the pre-W1 consent
receipt's `dcr_client_ids[0]`) and a fresh human GoTrue access token in
`/Users/yulanbot/work/c1-run/probe-credentials-W2-<window_id>.json` (0600),
with exactly: release_sha, window_id, workspace_id, mcp_client_id,
mcp_refresh_token, mcp_resource (`https://mcp.commonswarm.com/mcp`),
human_access_token and human_token_exp (integer JWT exp). ai-w2-stage-probes
validates it on the Mac (0600, exact keys, release/window/workspace equal to
INPUTS, human_token_exp >= window_end_utc + 300 s; otherwise STOP before any W2
write), uploads its bytes on stdin in ONE ssh call to
`$SECRET_STAGE/ordinary-probes.json` (0600), compares only digests, then
deletes the local file with the guarded rm and proves it is gone. Values never
enter argv, env, proof or output.

Every probe (ai-w2-between-probes) refreshes first: grant_type=refresh_token
with mcp_client_id and mcp_resource at the discovered token_endpoint; on 200 it
writes the rotated refresh token back atomically (temp file in SECRET_STAGE,
fsync, rename, 0600) BEFORE it uses the new access token for MCP initialize,
then reads pending_access with human_access_token. Discovery, initialize and the
human read may retry ONCE on a transport timeout or connection error, never on
an HTTP status; the refresh grant is NEVER retried. Any failure STOPs before the
next migration. Every probe also requires rotation: a 200 refresh must return a
NEW refresh token. The same probe runs once immediately BEFORE ai-w2-apply
writes apply-started.txt (`between-prefence.json`), and so proves the revoke
PRECONDITIONS before the fence: a refresh_token grant with the staged token
returns 200 with a new refresh token (rotation is on, which the replay
revocation depends on), persisted atomically before use, and MCP initialize
succeeds with the new access token. A failure there applies nothing. The replay
itself cannot be exercised before the fence without revoking the grant the
between-probes need, so it runs after the loop and on every exit and is proven
there.

The live issuer advertises no revocation_endpoint (the oidc-provider revocation
feature is off), so the plan revokes WITHOUT RFC 7009, by oidc-provider 9.12.2
replay revocation (`lib/actions/grants/refresh_token.js`: a refresh with an
already consumed refresh token destroys it, revokes the whole grant and returns
invalid_grant). After the loop, and on every W2 exit path that reached the
stage (the EXIT guards and ai-close), ai-w2-revoke-probes makes three refresh
requests at the issuer-origin token_endpoint, each exactly once: (1) with the
current token, which must return 200 with a new refresh token (persisted
atomically, never retried); (2) with the old, now consumed token, which must
return 400 invalid_grant (this is the revocation); (3) with the new token, which
must return 400 invalid_grant, the PROOF that the family is revoked
(`dcr-probe-revoked.json`). This is the ONLY accepted proof: a NEW token that
step (1) issued, the replay of the OLD one rejected, and the NEW one rejected.
Two rejections of the same token never count. If step (1) returns invalid_grant
(the held token is unknown, expired, destroyed or already consumed, for example
after a lost refresh response), nothing proves the grant is gone, because
oidc-provider revokes a grant only for a consumed token that still exists: that
is REVOKE-UNPROVEN, STOP, no proof file. Discovery need not advertise a revocation_endpoint anywhere; the
token_endpoint must be on the issuer origin. An unproven revoke is
REVOKE-UNPROVEN with a STOP report, never a partial apply.
If ai-w2-stage-probes fails anywhere after the local file validated, it
revokes the grant the same way by replay (from the local copy, or from the box copy when
the local one is gone), deletes the local file with the guarded rm, proves
absence and STOPs; a retry needs a new DCR grant (a new consent run). The upload
writes `probe-staged.txt` in PROOF_DIR, a durable revoke obligation: the EXIT
guards of ai-w2-preflight and ai-w2-apply and every ai-close run
ai-w2-revoke-probes while it exists without `dcr-probe-revoked.json`, and
ai-open-abort refuses. Each revoke is ONE attempt: `dcr-probe-revoke-attempted.txt`
is written before the first grant request, a started revoke is never re-run, and
an unproven one is recorded as REVOKE-UNPROVEN (`dcr-probe-revoke-unproven.json`)
and STOPs for HezLead. ai-close then refuses to close (naming the client_id) until
HezLead supplies `W2_REVOKE_UNPROVEN_ACCEPTED=<absolute path>` to a ruling file
(regular, not a symlink, mode 0600 or 0644) with exactly `action`
(`accept-unproven-dcr-revoke`), `approver` (`HezLead`), `release_sha`,
`window_id`, `plan_sha256`, `client_id` and `at`; each is bound to INPUTS and to
the client_id in the nonsecret `dcr-probe-revoke-unproven.json`. The file is read
completely (at most 64 KiB) and parsed and hashed as those exact bytes. ai-close
validates it before any other close check and again, finally, before the secret
stage is removed (a refusal there leaves the window retryable); the validated
payload is kept in memory and written with its sha256 to
`dcr-probe-revoke-accepted.json` only in the successful close commit, just before
closed.txt, so a window is never stuck open. A W2 that
stopped before its fence (no apply-started.txt) closes by proving the ledger
matches ledger-at-open.txt captured at open, without issuer-rollback;
admin_cutover_state does not exist before W2 applies. A new W2 open refuses
when all five 20261003 versions are already present.
This plan does not invent issuance; the producer's final cleanup relies on this
revoke proof.

`HISTORICAL_ARCHIVES_DIR` is a root-owned directory of immutable reviewed
`<released_sha>.tar` archives from the historical release inputs (release-record
rows only). The W2 backfill verifier (ai-w2-backfill, run by ai-w2-preflight)
checks every archive's migration bytes against BACKFILL_FILE.
It also checks the current files: if historical and reviewed hashes disagree,
STOP rather than changing observed evidence to fit a new build.

```sh
# step: ai-w2-stage-probes
# readonly: no
# host: Mac /bin/bash 3.2; after ai-open, before ai-w2-preflight; one ssh upload on stdin, secrets never in argv/env/output
set -euo pipefail
: "${INPUTS_FILE:?FAIL ai-w2-stage-probes: INPUTS_FILE expected absolute-regular-file got unset; STOP}"
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm || { printf 'FAIL ai-w2-stage-probes: rm expected guarded /Users/yulanbot/.local/bin/rm got other; STOP\n' >&2; exit 1; }
W2_RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
W2_WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
PROBE_CREDENTIALS_FILE=/Users/yulanbot/work/c1-run/probe-credentials-W2-$W2_WINDOW_ID.json
test ! -e "$PROBE_CREDENTIALS_FILE.revoke-attempted" || { printf 'REVOKE-UNPROVEN ai-w2-stage-probes: an earlier local revoke attempt exists; never retried automatically; STOP\n' >&2; exit 1; }
# Validation reads the file once by a non-following fd and prints only its sha256; nothing is written before it passes.
PROBE_SHA256=$(python3 -c '
import calendar,hashlib,json,os,re,stat,sys,time
inputs,name=sys.argv[1:3]
def fail(what,expected,got): raise SystemExit("FAIL ai-w2-stage-probes: "+what+" expected "+expected+" got "+got+"; STOP before any W2 write")
d=json.load(open(inputs))
if d.get("window")!="W2": fail("INPUTS window","W2","other")
try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
except OSError: fail("probe credentials file","regular-file","missing-or-symlink")
try:
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid(): fail("probe credentials file","0600-regular-file-owned-by-caller","other-mode-or-owner")
    chunks=[]
    while True:
        chunk=os.read(fd,65536)
        if not chunk: break
        chunks.append(chunk)
finally: os.close(fd)
raw=b"".join(chunks)
try: c=json.loads(raw)
except ValueError: c=None
keys={"release_sha","window_id","workspace_id","mcp_client_id","mcp_refresh_token","mcp_resource","human_access_token","human_token_exp"}
if not (isinstance(c,dict) and set(c)==keys): fail("probe credentials keys","probe-contract-keys","other-set")
if c["release_sha"]!=d["release_sha"]: fail("probe credentials release_sha","input-release-sha","mismatch")
if c["window_id"]!=d["window_id"]: fail("probe credentials window_id","input-window-id","mismatch")
if c["workspace_id"]!=d.get("probe_workspace_id"): fail("probe credentials workspace_id","input-probe-workspace-id","mismatch")
if c["mcp_resource"]!="https://mcp.commonswarm.com/mcp": fail("probe credentials mcp_resource","https://mcp.commonswarm.com/mcp","other")
if not (isinstance(c["mcp_client_id"],str) and re.fullmatch(r"[A-Za-z0-9._:/-]{1,512}",c["mcp_client_id"])): fail("probe credentials mcp_client_id","bounded-id","other")
if not all(isinstance(c[k],str) and 0<len(c[k])<=16384 for k in ("mcp_refresh_token","human_access_token")): fail("probe credentials tokens","bounded-strings","other")
end=calendar.timegm(time.strptime(d["window_end_utc"],"%Y-%m-%dT%H:%M:%SZ"))
if type(c["human_token_exp"]) is not int or c["human_token_exp"]<end+300: fail("human_token_exp","window_end_utc-plus-300s","shorter")
print(hashlib.sha256(raw).hexdigest())
' "$INPUTS_FILE" "$PROBE_CREDENTIALS_FILE")
W2_PROOF_DIR=/home/commonswarm/admin-issuance/release-proofs/$W2_RELEASE_SHA-W2-$W2_WINDOW_ID
# One ssh call: the box resolves the window's retained secret-stage pointer, installs stdin as 0600 and reports mode and digest only.
W2_REMOTE_SCRIPT='set -euo pipefail; stage=$(cat "$1/secret-stage.path"); case "$stage" in /tmp/anvil-secret.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) exit 65;; esac; test -d "$stage"; test ! -L "$stage"; test "$(stat -c %a "$stage")" = 700; f=$stage/ordinary-probes.json; test ! -e "$f"; test ! -L "$f"; install -o root -g root -m 600 /dev/stdin "$f"; date -u +%Y-%m-%dT%H:%M:%SZ >"$1/probe-staged.txt"; mode=$(stat -c %a "$f"); digest=$(sha256sum "$f" | cut -d " " -f 1); printf "%s %s\n" "$mode" "$digest"'
printf -v W2_REMOTE 'sudo -n /bin/bash -c %q _ %q' "$W2_REMOTE_SCRIPT" "$W2_PROOF_DIR"
# After validation, EVERY failure revokes the grant by replay (one attempt): from the local copy when it is
# still there, otherwise from the box copy through the verified plan's ai-w2-revoke-probes; then the
# local copy is removed with the guarded rm and its absence proven, and the block STOPs.
W2_SSH_ATTEMPTED=0
w2_local_revoke() {
 python3 -c '
import json,os,re,secrets,socket,stat,sys,urllib.error,urllib.parse,urllib.request
name=sys.argv[1]; marker=name+".revoke-attempted"; I="https://mcp.commonswarm.com"
def fail(what): raise SystemExit("FAIL ai-w2-stage-probes: local revoke "+what+"; STOP")
def unproven(what): raise SystemExit("REVOKE-UNPROVEN ai-w2-stage-probes: local revoke "+what+"; local file retained 0600 for HezLead; never retried automatically; STOP")
fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): fail("expected regular file")
    raw=os.read(fd,1048576)
finally: os.close(fd)
c=json.loads(raw)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
TRANSPORT=(urllib.error.URLError,socket.timeout,TimeoutError,ConnectionError,OSError)
def send(url,form=None):
    data=None if form is None else urllib.parse.urlencode(form).encode()
    req=urllib.request.Request(url,data=data,headers={"Accept":"application/json","User-Agent":"curl/8.7.1"})
    try:
        with opener.open(req,timeout=15) as r: return r.status,r.read(1048577)
    except urllib.error.HTTPError as e: return e.code,e.read(1048577)
# Only a transport error may retry discovery once; a malformed or non-200 response never retries.
reply=None
for attempt in (1,2):
    try: reply=send(I+"/.well-known/oauth-authorization-server"); break
    except TRANSPORT:
        if attempt==2: fail("discovery expected response got transport-error-after-one-retry")
status,body=reply
try: d=json.loads(body) if status==200 else None
except ValueError: d=None
if not isinstance(d,dict) or d.get("issuer")!=I: fail("discovery expected HTTP-200-issuer-metadata got other")
token=d.get("token_endpoint")
if not (isinstance(token,str) and token.startswith(I+"/")): fail("discovery expected issuer-origin token endpoint")
mfd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.close(mfd)
# Replay revocation (no RFC 7009): rotate, replay the consumed token, prove the new token is rejected; each once.
def grant(rt,step):
    try: status,body=send(token,{"grant_type":"refresh_token","client_id":c["mcp_client_id"],"refresh_token":rt,"resource":c["mcp_resource"]})
    except TRANSPORT: unproven(step+" got transport-error-not-retried")
    try: return status,json.loads(body)
    except ValueError: return status,None
def rejected(status,t): return status==400 and isinstance(t,dict) and t.get("error")=="invalid_grant"
def keep(t):
    if isinstance(t,dict) and isinstance(t.get("refresh_token"),str) and 0<len(t["refresh_token"])<=16384:
        c["mcp_refresh_token"]=t["refresh_token"]; tmp=name+"."+secrets.token_hex(6)+".tmp"
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try: os.write(fd,json.dumps(c).encode()); os.fsync(fd)
        finally: os.close(fd)
        os.rename(tmp,name)
status,t=grant(c["mcp_refresh_token"],"step 1 rotation refresh")
if rejected(status,t): unproven("step 1 rotation refresh got HTTP-400-invalid_grant; the held token cannot prove the family revoked")
elif status==200 and isinstance(t,dict) and isinstance(t.get("refresh_token"),str) and 0<len(t["refresh_token"])<=16384 and t["refresh_token"]!=c["mcp_refresh_token"]:
    old=c["mcp_refresh_token"]; keep(t)
    status,t=grant(old,"step 2 consumed-token replay")
    if not rejected(status,t): keep(t); unproven("step 2 consumed-token replay expected HTTP-400-invalid_grant got HTTP-"+str(status))
else:
    keep(t); unproven("step 1 rotation refresh expected HTTP-200-new-token-or-400-invalid_grant got HTTP-"+str(status))
status,t=grant(c["mcp_refresh_token"],"step 3 proof refresh")
if not rejected(status,t): keep(t); unproven("step 3 proof refresh expected HTTP-400-invalid_grant got HTTP-"+str(status))
print(json.dumps({"client_id":c["mcp_client_id"],"revoked":True,"proof":"refresh rejected"},sort_keys=True))
' "$PROBE_CREDENTIALS_FILE"
}
w2_stage_fail() {
 printf 'FAIL ai-w2-stage-probes: %s; revoking the probe grant; STOP\n' "$1" >&2
 if test -f "$PROBE_CREDENTIALS_FILE" && test ! -L "$PROBE_CREDENTIALS_FILE"; then
  W2_REVOKE_PROOF=$(w2_local_revoke) || exit 1
  if test "$W2_SSH_ATTEMPTED" = 1; then
   # The box copy holds the same, now revoked, token: record the proof there so no later step re-proves it.
   printf -v W2_PROOF_REMOTE 'sudo -n /bin/bash -c %q _ %q %q' 'set -euo pipefail; test -f "$1/probe-staged.txt" || exit 0; set -C; printf "%s\n" "$2" >"$1/dcr-probe-revoked.json"' "$W2_PROOF_DIR" "$W2_REVOKE_PROOF"
   ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$W2_PROOF_REMOTE" </dev/null || printf 'FAIL ai-w2-stage-probes: box revoke proof write failed; the recovered ai-close re-proves on the box; STOP\n' >&2
  fi
 else
  # No local copy left: revoke from the box copy with the verified plan's single-attempt revoke block.
  W2_REVOKE_BLOCK=$(python3 -c '
import hashlib,json,os,re,stat,sys
plan,inputs=sys.argv[1:3]
fd=os.open(plan,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise SystemExit("FAIL ai-w2-stage-probes: PLAN_FILE expected regular-file got other; STOP")
    chunks=[]
    while True:
        chunk=os.read(fd,1048576)
        if not chunk: break
        chunks.append(chunk)
finally: os.close(fd)
raw=b"".join(chunks)
if hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get("plan_sha256"): raise SystemExit("FAIL ai-w2-stage-probes: PLAN_FILE expected input-plan_sha256 got digest-mismatch; STOP")
found=[b for b in re.findall(r"^`{3}sh\n(.*?)^`{3}$",raw.decode(),re.M|re.S) if b.startswith("# step: ai-w2-revoke-probes\n")]
if len(found)!=1: raise SystemExit("FAIL ai-w2-stage-probes: ai-w2-revoke-probes block expected one got other; STOP")
sys.stdout.write(found[0])
' "$PLAN_FILE" "$INPUTS_FILE") || exit 1
  printf -v W2_BOX_REVOKE 'sudo -n /bin/bash -c %q _ %q %q' 'stage=$(cat "$1/secret-stage.path"); exec env WINDOW=W2 PROOF_DIR="$1" SECRET_STAGE="$stage" RELEASE_SHA="$2" /bin/bash -s' "$W2_PROOF_DIR" "$W2_RELEASE_SHA"
  printf '%s\n' "$W2_REVOKE_BLOCK" | ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$W2_BOX_REVOKE" || { printf 'REVOKE-UNPROVEN ai-w2-stage-probes: box revoke not proven; the box probe-staged.txt marker keeps the obligation for ai-close; STOP\n' >&2; exit 1; }
 fi
 if test -e "$PROBE_CREDENTIALS_FILE" || test -L "$PROBE_CREDENTIALS_FILE"; then
  rm -- "$PROBE_CREDENTIALS_FILE" || { printf 'FAIL ai-w2-stage-probes: guarded rm of the (revoked) local probe credentials refused; retain path and guard message; STOP\n' >&2; exit 1; }
 fi
 test ! -e "$PROBE_CREDENTIALS_FILE" || { printf 'FAIL ai-w2-stage-probes: local probe credentials (revoked) expected absent got present; STOP\n' >&2; exit 1; }
 test ! -L "$PROBE_CREDENTIALS_FILE" || { printf 'FAIL ai-w2-stage-probes: local probe credentials (revoked) expected absent got symlink; STOP\n' >&2; exit 1; }
 printf 'STOP ai-w2-stage-probes: probe grant revoked and local copy removed; a retry needs a new DCR grant (new consent run)\n' >&2
 exit 1
}
W2_SSH_ATTEMPTED=1
W2_UPLOAD=$(ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$W2_REMOTE" <"$PROBE_CREDENTIALS_FILE") || w2_stage_fail 'ssh upload expected success got failure'
test "$W2_UPLOAD" = "600 $PROBE_SHA256" || w2_stage_fail 'box ordinary-probes.json expected 0600-and-same-sha256 got mismatch'
rm -- "$PROBE_CREDENTIALS_FILE" || w2_stage_fail 'guarded rm of local probe credentials refused'
test ! -e "$PROBE_CREDENTIALS_FILE" || w2_stage_fail 'local probe credentials expected absent got present'
test ! -L "$PROBE_CREDENTIALS_FILE" || w2_stage_fail 'local probe credentials expected absent got symlink'
printf 'PASS ai-w2-stage-probes: box ordinary-probes.json 0600 with matching digest; local copy removed\n'
```

```sh
# step: ai-w2-preflight
# readonly: no
# host: box root; database read-only, writes proof files
set -euo pipefail
test "$WINDOW" = W2
# Every exit from here revokes a staged DCR probe grant (the block itself skips when nothing is staged,
# and never re-runs a started revoke).
w2_probe_exit() {
 local status=$?
 trap - EXIT
 # The guard runs only on an unfinished block; bash reports 0 for a ${VAR:?} exit, so force a failure status.
 test "$status" != 0 || status=1
 # Subshell: a failing revoke must reach this message even though the block re-enables set -e.
 ( ai_run ai-w2-revoke-probes ) || printf 'FAIL %s: DCR probe grant revoke on exit expected proven got failed; STOP\n' "$W2_GUARD_STEP" >&2
 exit "$status"
}
W2_GUARD_STEP=ai-w2-preflight
trap w2_probe_exit EXIT
ai_deadline
: "${BACKFILL_FILE:?}" "${HISTORICAL_ARCHIVES_DIR:?}" "${W1_CLOSED_FILE:?}"
python3 - "$W1_CLOSED_FILE" "$RELEASE_SHA" <<'PY'
import datetime,json,pathlib,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
d=json.load(open(p.parent/"inputs.json")); assert d["window"]=="W1" and d["release_sha"]==sys.argv[2]
closed_at=box_utc(p.read_text().strip()); assert closed_at is not None, "FAIL W1 closed.txt expected aware-UTC-ISO-8601-time got other; STOP"
assert 0<=(datetime.datetime.now(datetime.timezone.utc)-closed_at).total_seconds()<=1800, "FAIL fresh W1 close; STOP"
PY
BACKUP_GATE_DIR="${W1_CLOSED_FILE%/*}"
( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-w2-preflight: W1: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
unset BACKUP_GATE_DIR
test -f "$PROOF_DIR/ordinary-before.json"
test -f "$PROOF_DIR/consent-pre-W1.json" || { printf 'FAIL ai-w2-preflight: retained consent receipt expected consent-pre-W1.json got missing; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-before.json" "$PROOF_DIR/consent-pre-W1.json" before no ai-w2-preflight <<'PY' || { printf 'FAIL ai-w2-preflight: retained before receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
ai_run ai-w2-backfill
python3 - "$RELEASE_ROOT" "$PROOF_DIR" <<'PY'
import hashlib,json,pathlib,sys
root,proof=map(pathlib.Path,sys.argv[1:3])
ledger=(proof/'ledger-before.txt').read_text().splitlines()
versions=['2026100300000'+str(i) for i in range(1,6)]
assert not any(v in ledger for v in versions), 'FAIL W2 unexpected applied prefix; STOP'
assert all(v in ledger for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']), 'FAIL prerequisites; STOP'
records=[]
for v in versions:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    reserve=root/'supabase/admin-delegation-reserve'/(v+'-rollback.sql')
    plan_reserve=root/'docs/evidence/2026-10-03-admin-issuance-release/reserve'/(v+'-rollback.sql')
    assert reserve.read_bytes()==plan_reserve.read_bytes(), 'FAIL reserve bytes; STOP'
    records.append({'version':v,'file':files[0].name,'sha256':hashlib.sha256(files[0].read_bytes()).hexdigest()})
(proof/'new-migrations.json').write_text(json.dumps(records,sort_keys=True)+'\n')
# Snapshot the reviewed expected set separately; never use this as historical evidence.
required=['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+versions
expected={}
for v in required:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    expected[v]=hashlib.sha256(files[0].read_bytes()).hexdigest()
(proof/'expected-migrations.json').write_text(json.dumps(expected,sort_keys=True)+'\n')
PY
# Current backup/restore evidence is read-only; neither starts an Actions run nor a drill.
python3 - /var/backups/commonswarm-postgres/status.json <<'PY'
import datetime,json,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
r=json.load(open(sys.argv[1]))
assert all(r.get(k) is True for k in ('ok','database_bytes_verified','object_bytes_verified'))
verified=box_utc(r.get('verified_at')); assert verified is not None, 'FAIL backup verified_at expected aware-UTC-ISO-8601-time got other; STOP'
age=(datetime.datetime.now(datetime.timezone.utc)-verified).total_seconds()
assert -300<=age<86400 and r['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/'), 'FAIL backup gate; STOP'
PY
# Before proofs: one reviewed before-apply catalog per version, read from the verified release
# archive, without invoking a reserve. The reverse catalogs also assert what each reserve KEEPS
# (0002: the issuer and policy roles; 0005: the six private tables), so they cannot hold before
# apply. Each <version>-before-catalog.sql keeps every other reverse row byte for byte and adds
# absence rows instead; every row is NULL-safe on a pre-W2 database (no name casts and no
# name-based privilege calls on objects or roles W2 creates). The full reverse catalogs remain
# the post-reserve proof.
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 BEFORE_CATALOG=/release/deploy/release-proofs/item-ai/$VERSION-before-catalog.sql
 printf '\\i %s\nSELECT :\x27before_ok\x27::boolean;\n' "$BEFORE_CATALOG" >"$PROOF_DIR/catalog.sql"
 BEFORE_OK=$(ai_ro -Atq --file /proof/catalog.sql)
 test "$BEFORE_OK" = t || { printf 'FAIL ai-w2-preflight: before-apply catalog for %s expected t got other; STOP\n' "$VERSION" >&2; exit 1; }
done
ai_ro -Atq --command "SELECT n.nspname,p.proname,p.prosecdef,p.proconfig::text,pg_get_userbyid(p.proowner),p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2,p.oid;" >"$PROOF_DIR/functions-before.txt"
ai_ro -Atq --command "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2;" >"$PROOF_DIR/relations-before.txt"
ai_ro -Atq --command 'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles ORDER BY rolname;' >"$PROOF_DIR/roles-before.txt"
ai_run ai-w2-measure
trap - EXIT
printf 'PASS W2 preflight: exact ledger/backfill/reserves/catalogs/bounds; backup fresh\n'
```

```sh
# step: ai-w2-backfill
# readonly: no
# host: box root; run by ai-w2-preflight through ai_run; database read-only, writes proof files
set -euo pipefail
test "$WINDOW" = W2
: "${BACKFILL_FILE:?FAIL ai-w2-backfill: BACKFILL_FILE expected absolute-regular-file got unset; STOP}"
: "${HISTORICAL_ARCHIVES_DIR:?FAIL ai-w2-backfill: HISTORICAL_ARCHIVES_DIR expected absolute-directory got unset; STOP}"
# The ledger's own recorded statements, read-only in the existing session: one JSON object per version.
ai_ro -Atq --command "SELECT json_build_object('version',version,'statements',statements)::text FROM supabase_migrations.schema_migrations ORDER BY version;" >"$PROOF_DIR/ledger-statements.jsonl"
python3 - "$PROOF_DIR" "$BACKFILL_FILE" "$HISTORICAL_ARCHIVES_DIR" "$RELEASE_SHA" "$BOX_ARCHIVE_PATH" "$INPUTS_FILE" "$RELEASE_ROOT" <<'PY'
import datetime,hashlib,io,json,os,pathlib,re,stat,sys,tarfile
proof,backfill,archives,sha,box_archive,inputs,root=sys.argv[1:8]
proof,root=pathlib.Path(proof),pathlib.Path(root)
MEANING="attested-baseline: no release record and no recorded statements; file bytes at RELEASE_SHA adopted as UNVERIFIED drift baseline"
KEYS={'release-record':{'version','evidence_kind','released_sha','sha256','file'},
      'ledger-statements':{'version','evidence_kind','file','matched_sha','sha256'},
      'attested-baseline':{'version','evidence_kind','file','sha256','attested_by','attested_at','reason'}}
def fail(what,expected,got): raise SystemExit('FAIL ai-w2-backfill: '+what+' expected '+expected+' got '+got+'; STOP')
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verbatim_cover(data,recorded):
    """Ordered verbatim cover: each recorded statement occurs byte-for-byte in data,
    in order and without overlap; every gap holds only whitespace and semicolons."""
    gap=b' \t\r\n\f\v;'; pos=0
    for statement in recorded:
        part=statement.encode()
        while pos<len(data) and data[pos] in gap: pos+=1
        if not part or not data.startswith(part,pos): return False
        pos+=len(part)
    return all(c in gap for c in data[pos:])
def tar_member(raw,member,what):
    try:
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            m=tar.getmember(member); data=tar.extractfile(m).read() if m.isfile() else None
    except (KeyError,OSError,tarfile.TarError): data=None
    if data is None: fail(member+' in '+what,'regular-file','missing')
    return data
def historical(commit):
    raw=read_regular(os.path.join(archives,commit+'.tar'))
    if raw is None: fail('historical archive '+commit+'.tar','regular-file','missing-or-not-regular')
    return raw
if not (os.path.isabs(archives) and os.path.isdir(archives) and not os.path.islink(archives)): fail('HISTORICAL_ARCHIVES_DIR','absolute-directory','other')
raw=read_regular(backfill) if os.path.isabs(backfill) else None
if raw is None: fail('BACKFILL_FILE','absolute-regular-file','missing-or-not-regular')
try: rows=json.loads(raw)
except ValueError: rows=None
if not isinstance(rows,list) or not all(isinstance(r,dict) for r in rows): fail('BACKFILL_FILE','list-of-objects','other')
ledger=(proof/'ledger-before.txt').read_text().splitlines()
statements={}
for line in (proof/'ledger-statements.jsonl').read_text().splitlines():
    item=json.loads(line); v=item['version']
    if v in statements: fail('ledger statements version '+v,'one-row','duplicate')
    statements[v]=item['statements']
if sorted(statements)!=ledger: fail('ledger statements versions','ledger-before','different')
release_raw=read_regular(box_archive) if os.path.isabs(box_archive) else None
if release_raw is None or hashlib.sha256(release_raw).hexdigest()!=json.load(open(inputs)).get('archive_sha256'): fail('BOX_ARCHIVE_PATH','verified-release-archive','missing-or-mismatch')
seen=set(); kinds={}; attested=[]; evidence={}
for r in rows:
    kind=r.get('evidence_kind'); v=r.get('version')
    if kind not in KEYS: fail('evidence_kind for '+str(v),'release-record|ledger-statements|attested-baseline','unknown')
    extra={'pointer','written_by'} if kind=='attested-baseline' else set()
    if not KEYS[kind]<=set(r)<=KEYS[kind]|extra: fail(kind+' row keys for '+str(v),'exact-kind-keys','other-set')
    if not (isinstance(v,str) and re.fullmatch('[0-9]{14}',v)): fail('row version','14-digit-string','other')
    if v in seen: fail('backfill row '+v,'one-row','duplicate')
    seen.add(v)
    if v not in statements: fail('backfill row '+v,'ledger-version','not-in-ledger')
    if not (isinstance(r['sha256'],str) and re.fullmatch('[0-9a-f]{64}',r['sha256'])): fail('sha256 for '+v,'64-hex','other')
    if not (isinstance(r['file'],str) and re.fullmatch('supabase/migrations/'+v+'_[a-z0-9_]+[.]sql',r['file'])): fail('file for '+v,'supabase/migrations/'+v+'_<name>.sql','other')
    recorded=statements[v]
    if kind=='release-record':
        if not re.fullmatch('[0-9a-f]{40}',str(r['released_sha'])): fail('released_sha for '+v,'40-hex','other')
        original=tar_member(historical(r['released_sha']),r['file'],r['released_sha']+'.tar')
        if hashlib.sha256(original).hexdigest()!=r['sha256']: raise SystemExit('FAIL historical backfill hash; STOP')
        if (root/r['file']).read_bytes()!=original: raise SystemExit('FAIL historical/current migration drift; STOP')
        evidence[v]={'evidence_kind':kind,'released_sha':r['released_sha'],'sha256':r['sha256'],'file':r['file']}
    elif kind=='ledger-statements':
        if not re.fullmatch('[0-9a-f]{40}',str(r['matched_sha'])): fail('matched_sha for '+v,'40-hex','other')
        if not (isinstance(recorded,list) and recorded and all(isinstance(x,str) for x in recorded)): fail('ledger statements for '+v,'non-empty','null-or-empty')
        if r['matched_sha']!=sha: fail('matched_sha for '+v,'RELEASE_SHA','other')
        data=tar_member(release_raw,r['file'],'release archive')
        if hashlib.sha256(data).hexdigest()!=r['sha256']: fail('sha256 of '+r['file']+' at matched_sha','row-sha256','mismatch')
        if not verbatim_cover(data,recorded): fail('ledger statements for '+v,'ordered-verbatim-cover-by-file-at-RELEASE_SHA','mismatch')
        evidence[v]={'evidence_kind':kind,'matched_sha':r['matched_sha'],'sha256':r['sha256'],'file':r['file'],'match':'ordered-verbatim-cover','recorded_statements':len(recorded)}
    else:
        if recorded not in (None,[]): fail('ledger statements for attested-baseline '+v,'null-or-empty','non-empty; the row must be ledger-statements')
        if r['attested_by']!='HezLead': fail('attested_by for '+v,'HezLead','other')
        at=r['attested_at']
        try: when=datetime.datetime.strptime(at,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc) if isinstance(at,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',at) else None
        except ValueError: when=None
        if when is None or when>datetime.datetime.now(datetime.timezone.utc): fail('attested_at for '+v,'UTC-Z-not-future','other')
        reason=r['reason']
        if not (isinstance(reason,str) and reason.strip() and len(reason)<=2000 and not any(ord(ch)<32 or ord(ch)==127 for ch in reason)): fail('reason for '+v,'non-empty-single-line-at-most-2000-chars','other')
        data=tar_member(release_raw,r['file'],'release archive')
        if hashlib.sha256(data).hexdigest()!=r['sha256']: fail('sha256 of '+r['file']+' at RELEASE_SHA','row-sha256','mismatch')
        attested.append(v)
        evidence[v]={'evidence_kind':kind,'sha256':r['sha256'],'file':r['file'],'attested_by':r['attested_by'],'attested_at':r['attested_at'],'reason':r['reason']}
    kinds[v]=kind
# Isolation (HezLead 2026-10-06): production must not accept c1-staging attestations.
# Pin is sha256 of json.dumps(production rows, sort_keys=True, separators=(',',':')) from
# the 2026-10-04 attestations-W2.json rows (version,name,attested_by,attested_at,reason).
marker_path='/etc/commonswarm-release/STAGING-ONLY'
marker_content=b'c1-staging-disposable-no-production'
PROD_ATTEST_PIN='b17a55e8c078945af8df0c56dcb272682d1e22fb7318b529a633cf9468d70031'
PROD_ATTEST_VERSIONS=('20260916000001','20260916000002')
def staging_marker():
    try: fd=os.open(marker_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        if os.path.lexists(marker_path): fail('box staging marker','regular-root-root-0600-exact-content','malformed')
        return False
    except OSError:
        fail('box staging marker','regular-root-root-0600-exact-content','malformed')
    try:
        info=os.fstat(fd)
        if not (stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size==len(marker_content) and os.read(fd,len(marker_content)+1)==marker_content):
            fail('box staging marker','regular-root-root-0600-exact-content','malformed')
        return True
    finally: os.close(fd)
staging=staging_marker()
iso=[]
for r in rows:
    if r.get('evidence_kind')!='attested-baseline': continue
    v=r['version']
    for field in ('pointer','written_by','reason','attested_by','attested_at'):
        if field in r and not isinstance(r[field],str): fail('attestation '+field+' for '+v,'string','non-string')
    pointer=r['pointer'] if isinstance(r.get('pointer'),str) else ''
    written=r['written_by'] if isinstance(r.get('written_by'),str) else ''
    reason=r['reason'] if isinstance(r.get('reason'),str) else ''
    if staging:
        if not pointer.startswith('c1-staging/'): fail('attestation pointer for '+v,'c1-staging/ prefix','other')
    else:
        if any('c1-staging' in s for s in (pointer,reason,written)): fail('attestation for '+v,'production-not-c1-staging','c1-staging')
        if v in PROD_ATTEST_VERSIONS:
            name=r['file'].rsplit('/',1)[-1]
            if name.startswith(v+'_') and name.endswith('.sql'): name=name[len(v)+1:-4]
            iso.append({'version':v,'name':name,'attested_by':r['attested_by'],'attested_at':r['attested_at'],'reason':reason})
if not staging and iso:
    iso.sort(key=lambda x:x['version'])
    digest=hashlib.sha256(json.dumps(iso,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if digest!=PROD_ATTEST_PIN: fail('production attestation rows','pinned-2026-10-04-canonical-sha256','mismatch')
missing=[v for v in ledger if v not in seen]
if missing: fail('backfill rows','every-ledger-version','missing-'+str(len(missing)))
counts={k:sum(1 for x in kinds.values() if x==k) for k in KEYS}
record=(json.dumps({'release_sha':sha,'counts':counts,'attested_meaning':MEANING,'versions':evidence},sort_keys=True)+'\n').encode()
(proof/'backfill.json').write_text(json.dumps(rows,sort_keys=True)+'\n')
(proof/'backfill-evidence.json').write_bytes(record)
for v in attested: print(v+' '+MEANING)
print('PASS ai-w2-backfill: '+', '.join(k+'='+str(counts[k]) for k in KEYS)+'; backfill-evidence.json sha256='+hashlib.sha256(record).hexdigest())
PY
```

```sh
# step: ai-w2-measure
# readonly: no
# host: box root; read-only SQL, nonsecret measurements/limits only
set -euo pipefail
test "$WINDOW" = W2
ai_deadline
python3 - "$PROOF_DIR" <<'PY'
import json,pathlib
p=pathlib.Path(__import__('sys').argv[1]); MiB=1024**2
# One live-table inventory owns measurement, bounds and under-lock recheck.
tables=[
 ('commonswarm_oauth.interactions',100000,256,[1],'ACCESS EXCLUSIVE'),
 ('swarm.admin_grants',100000,128,[1,3],'ACCESS EXCLUSIVE'),
 ('swarm.hosted_mcp_grants',100000,256,[1],'SHARE ROW EXCLUSIVE'),
 ('commonswarm_oauth.provider_artifacts',1000000,1024,[1],'SHARE ROW EXCLUSIVE'),
 ('swarm.users',100000,128,[1],'SHARE ROW EXCLUSIVE'),
 ('swarm.admin_accounts',100000,128,[1,2,3],'SHARE ROW EXCLUSIVE'),
 ('swarm.admin_consents',200000,256,[1],'SHARE ROW EXCLUSIVE'),
 ('swarm.admin_events',1000000,1024,[2,3],'SHARE ROW EXCLUSIVE'),
 ('swarm.admin_credentials',100000,128,[3],'SHARE ROW EXCLUSIVE'),
 ('commonswarm_oauth.refresh_family_tombstones',1000000,256,[3],'SHARE ROW EXCLUSIVE'),
 ('supabase_migrations.schema_migrations',10000,16,[1,2,3,4,5],'EXCLUSIVE')]
(p/'lock-limits.json').write_text(json.dumps([dict(table=t,max_rows=r,max_bytes=b*MiB,migrations=m,mode=l) for t,r,b,m,l in tables])+'\n')
(p/'measure-tables.txt').write_text('\n'.join(t[0] for t in tables)+'\n')
PY
: >"$PROOF_DIR/table-measurements.txt"
while IFS= read -r TABLE; do
 ai_deadline
 START_SECONDS=$SECONDS
 OBSERVED=$(ai_ro -Atq --command "SET lock_timeout='3s'; SET statement_timeout='60s'; SET transaction_timeout='60s'; SELECT count(*),pg_total_relation_size('$TABLE'::regclass) FROM $TABLE;")
 printf '%s|%s|%s\n' "$TABLE" "$OBSERVED" "$((SECONDS-START_SECONDS))" >>"$PROOF_DIR/table-measurements.txt"
done <"$PROOF_DIR/measure-tables.txt"
python3 - "$PROOF_DIR" <<'PY'
import datetime,json,math,pathlib,sys
p=pathlib.Path(sys.argv[1]); limits=json.loads((p/'lock-limits.json').read_text())
rows=[r.split('|') for r in (p/'table-measurements.txt').read_text().splitlines()]
assert len(rows)==len(limits) and [r[0] for r in rows]==[r['table'] for r in limits], 'FAIL complete measurement inventory; STOP'
for l,r in zip(limits,rows):
    assert len(r)==4
    l.update(rows=int(r[1]),bytes=int(r[2]),count_seconds=int(r[3]))
    assert 0<=l['rows']<=l['max_rows'] and 0<=l['bytes']<=l['max_bytes'], 'FAIL live table refuse bounds: '+l['table']+'; STOP'
    assert 0<=l['count_seconds']<60, 'FAIL slow measurement; STOP'
expected=[30,15,15,10,10]; budgets=[]
for i,hold in enumerate(expected,1):
    live=[l for l in limits if i in l['migrations']]
    sized=15+math.ceil(sum(l['rows'] for l in live)/10000)+math.ceil(sum(l['bytes'] for l in live)/(32*1024**2))+sum(l['count_seconds'] for l in live)
    budgets.append(dict(migration=i,expected_hold_seconds=hold,timeout_seconds=min(60,max(hold,sized))))
(p/'lock-measurements.json').write_text(json.dumps(dict(measured_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),tables=limits,budgets=budgets),sort_keys=True)+'\n')
PY
printf 'PASS W2 measured every locked live table within row/size bounds\n'
```

```sh
# step: ai-w2-between-probes
# readonly: probe
# host: box root; refresh-per-probe of the dedicated DCR grant and public/authenticated reads; secrets never output
set -euo pipefail
ai_deadline
python3 - "$SECRET_STAGE" "$PROOF_DIR" "${PROBE_POINT:-$VERSION}" "$RELEASE_SHA" <<'PY'
import datetime,json,os,pathlib,re,secrets,socket,stat,sys,urllib.error,urllib.parse,urllib.request
stage,proof=map(pathlib.Path,sys.argv[1:3]); label,sha=sys.argv[3:]
if not re.fullmatch(r'prefence|2026100300000[1-5]',label): raise SystemExit('FAIL ai-w2-between-probes: probe point expected prefence-or-W2-version got other; STOP')
after='the apply-started fence' if label=='prefence' else 'next migration'
def fail(what,expected,got): raise SystemExit('FAIL ai-w2-between-probes: '+label+' '+what+' expected '+expected+' got '+got+'; STOP before '+after)
def read_with_info(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None,None
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode): return None,None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks),info
            chunks.append(chunk)
    finally: os.close(fd)
KEYS={'release_sha','window_id','workspace_id','mcp_client_id','mcp_refresh_token','mcp_resource','human_access_token','human_token_exp'}
ISSUER='https://mcp.commonswarm.com'
def credentials():
    if not (re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(stage)) and not stage.is_symlink() and stat.S_IMODE(stage.stat().st_mode)==0o700): fail('SECRET_STAGE','0700-anvil-secret','other')
    raw,info=read_with_info(str(stage/'ordinary-probes.json'))
    if raw is None or stat.S_IMODE(info.st_mode)!=0o600: fail('ordinary-probes.json','0600-regular-file','missing-or-mode')
    try: c=json.loads(raw)
    except ValueError: c=None
    if not (isinstance(c,dict) and set(c)==KEYS): fail('ordinary-probes.json keys','probe-contract-keys','other-set')
    if c['release_sha']!=sha or c['mcp_resource']!=ISSUER+'/mcp': fail('ordinary-probes.json binding','release-and-resource','mismatch')
    if not all(isinstance(c[k],str) and 0<len(c[k])<=16384 for k in ('mcp_client_id','mcp_refresh_token','human_access_token')): fail('ordinary-probes.json values','bounded-strings','other')
    return c
def persist(c):
    # Rotated refresh token reaches the file atomically before any use of the new access token.
    tmp=stage/('.ordinary-probes.'+secrets.token_hex(6)+'.tmp')
    fd=os.open(str(tmp),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try: os.write(fd,json.dumps(c).encode()); os.fsync(fd)
    finally: os.close(fd)
    os.rename(str(tmp),str(stage/'ordinary-probes.json'))
    dfd=os.open(str(stage),os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
class Transport(Exception): pass
def send(url,body=None,token=None,form=None):
    headers={'Accept':'application/json, text/event-stream','User-Agent':'curl/8.7.1'}
    data=None
    if form is not None: data=urllib.parse.urlencode(form).encode(); headers['Content-Type']='application/x-www-form-urlencoded'
    elif body is not None: data=json.dumps(body).encode(); headers['Content-Type']='application/json'
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url,data=data,headers=headers)
    try:
        with opener.open(req,timeout=15) as response: status,raw=response.status,response.read(1048577)
    except urllib.error.HTTPError as error: status,raw=error.code,error.read(1048577)
    except (urllib.error.URLError,socket.timeout,TimeoutError,ConnectionError,OSError): raise Transport() from None
    if len(raw)>1048576: return status,None
    try: return status,json.loads(raw) if raw else {}
    except ValueError: return status,None
def idempotent(what,url,body=None,token=None):
    # Retry ONCE on a transport error only; an HTTP status is never retried.
    for attempt in (1,2):
        try: status,value=send(url,body,token)
        except Transport:
            if attempt==2: fail(what,'response','transport-error-after-one-retry')
            continue
        if status!=200 or not isinstance(value,dict): fail(what,'HTTP-200-JSON','HTTP-'+str(status))
        return value
def endpoint(value,what):
    if not (isinstance(value,str) and value.startswith(ISSUER+'/')): fail('discovery '+what,'issuer-origin-endpoint','missing-or-foreign')
    return value
def discover():
    idempotent('health',ISSUER+'/health')
    d=idempotent('authorization server discovery',ISSUER+'/.well-known/oauth-authorization-server')
    if d.get('issuer')!=ISSUER: fail('discovery issuer',ISSUER,'other')
    r=idempotent('protected resource discovery',ISSUER+'/.well-known/oauth-protected-resource/mcp')
    if r.get('resource')!=ISSUER+'/mcp': fail('protected resource',ISSUER+'/mcp','other')
    return endpoint(d.get('token_endpoint'),'token_endpoint')
def refresh(c,token_url):
    # The refresh grant is NEVER retried: a lost response may already have rotated the family.
    try: status,t=send(token_url,form={'grant_type':'refresh_token','client_id':c['mcp_client_id'],'refresh_token':c['mcp_refresh_token'],'resource':c['mcp_resource']})
    except Transport: fail('refresh grant','HTTP-200','transport-error-not-retried')
    return status,t
c=credentials()
if not (type(c['human_token_exp']) is int and c['human_token_exp']>=datetime.datetime.now(datetime.timezone.utc).timestamp()+60): fail('human_token_exp','at-least-60s-left','expired')
token_url=discover()
status,t=refresh(c,token_url)
if status!=200 or not (isinstance(t,dict) and str(t.get('token_type','')).lower()=='bearer' and all(isinstance(t.get(k),str) and 0<len(t[k])<=16384 for k in ('access_token','refresh_token'))): fail('refresh grant','HTTP-200-Bearer-rotation','HTTP-'+str(status))
# Rotation is the precondition of the replay revocation: the 200 must carry a NEW refresh token.
if t['refresh_token']==c['mcp_refresh_token']: fail('refresh rotation','new-refresh-token','same-refresh-token')
c['mcp_refresh_token']=t['refresh_token']; persist(c)
mcp=idempotent('MCP initialize',ISSUER+'/mcp',{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'w2-ordinary-control','version':'1'}}},t['access_token'])
if mcp.get('id')!=1 or 'error' in mcp or 'serverInfo' not in mcp.get('result',{}): fail('MCP initialize','serverInfo','error')
human=idempotent('human pending_access read','https://api.commonswarm.com/functions/v1/read',{'resource':'pending_access','workspace_id':c['workspace_id']},c['human_access_token'])
if not isinstance(human.get('pending'),list) or 'error' in human: fail('human pending_access read','pending-list','error')
(proof/('between-'+label+'.json')).write_text(json.dumps(dict(release_sha=sha,version=label,at=datetime.datetime.now(datetime.timezone.utc).isoformat(),discovery=True,rotation=True,refreshed=True,token_health=True,human_read=True))+'\n')
PY
```

```sh
# step: ai-w2-revoke-probes
# readonly: no
# host: box root; replay revocation of the W2 probe DCR grant family (no RFC 7009) with a rejected-refresh proof; secrets never output
set -euo pipefail
# Runs as ( ai_run ai-w2-revoke-probes ) || ... in the W2 exit guards, where bash ignores errexit: fail explicitly.
test "$WINDOW" = W2 || { printf 'FAIL ai-w2-revoke-probes: window expected W2 got other; STOP\n' >&2; exit 1; }
python3 - "$SECRET_STAGE" "$PROOF_DIR" "$RELEASE_SHA" <<'PY'
import json,os,pathlib,re,secrets,socket,stat,sys,urllib.error,urllib.parse,urllib.request
stage,proof=map(pathlib.Path,sys.argv[1:3]); sha=sys.argv[3]
def fail(what,expected,got): raise SystemExit('FAIL ai-w2-revoke-probes: '+what+' expected '+expected+' got '+got+'; STOP')
def unproven(reason,client_id=None):
    # One attempt only: an unproven revoke is reported, never retried automatically.
    record=proof/'dcr-probe-revoke-unproven.json'
    if not record.exists(): record.write_text(json.dumps({'client_id':client_id,'revoked':False,'status':'REVOKE-UNPROVEN','reason':reason},sort_keys=True)+'\n')
    raise SystemExit('REVOKE-UNPROVEN ai-w2-revoke-probes: '+reason+'; STOP; HezLead revokes the DCR probe grant by client_id; never retried automatically')
if (proof/'dcr-probe-revoked.json').exists():
    print('PASS ai-w2-revoke-probes: DCR probe grant already revoked'); raise SystemExit(0)
if (proof/'dcr-probe-revoke-attempted.txt').exists(): unproven('a started revoke is never re-run')
if not (proof/'probe-staged.txt').exists():
    print('PASS ai-w2-revoke-probes: no DCR probe grant was staged'); raise SystemExit(0)
def read_with_info(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None,None
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode): return None,None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks),info
            chunks.append(chunk)
    finally: os.close(fd)
KEYS={'release_sha','window_id','workspace_id','mcp_client_id','mcp_refresh_token','mcp_resource','human_access_token','human_token_exp'}
ISSUER='https://mcp.commonswarm.com'
def credentials():
    if not (re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(stage)) and not stage.is_symlink() and stat.S_IMODE(stage.stat().st_mode)==0o700): fail('SECRET_STAGE','0700-anvil-secret','other')
    raw,info=read_with_info(str(stage/'ordinary-probes.json'))
    if raw is None or stat.S_IMODE(info.st_mode)!=0o600: fail('ordinary-probes.json','0600-regular-file','missing-or-mode')
    try: c=json.loads(raw)
    except ValueError: c=None
    if not (isinstance(c,dict) and set(c)==KEYS): fail('ordinary-probes.json keys','probe-contract-keys','other-set')
    if c['release_sha']!=sha or c['mcp_resource']!=ISSUER+'/mcp': fail('ordinary-probes.json binding','release-and-resource','mismatch')
    if not all(isinstance(c[k],str) and 0<len(c[k])<=16384 for k in ('mcp_client_id','mcp_refresh_token','human_access_token')): fail('ordinary-probes.json values','bounded-strings','other')
    return c
def persist(c):
    # Rotated refresh token reaches the file atomically before any use of the new access token.
    tmp=stage/('.ordinary-probes.'+secrets.token_hex(6)+'.tmp')
    fd=os.open(str(tmp),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try: os.write(fd,json.dumps(c).encode()); os.fsync(fd)
    finally: os.close(fd)
    os.rename(str(tmp),str(stage/'ordinary-probes.json'))
    dfd=os.open(str(stage),os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
class Transport(Exception): pass
def send(url,body=None,token=None,form=None):
    headers={'Accept':'application/json, text/event-stream','User-Agent':'curl/8.7.1'}
    data=None
    if form is not None: data=urllib.parse.urlencode(form).encode(); headers['Content-Type']='application/x-www-form-urlencoded'
    elif body is not None: data=json.dumps(body).encode(); headers['Content-Type']='application/json'
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url,data=data,headers=headers)
    try:
        with opener.open(req,timeout=15) as response: status,raw=response.status,response.read(1048577)
    except urllib.error.HTTPError as error: status,raw=error.code,error.read(1048577)
    except (urllib.error.URLError,socket.timeout,TimeoutError,ConnectionError,OSError): raise Transport() from None
    if len(raw)>1048576: return status,None
    try: return status,json.loads(raw) if raw else {}
    except ValueError: return status,None
def idempotent(what,url,body=None,token=None):
    # Retry ONCE on a transport error only; an HTTP status is never retried.
    for attempt in (1,2):
        try: status,value=send(url,body,token)
        except Transport:
            if attempt==2: fail(what,'response','transport-error-after-one-retry')
            continue
        if status!=200 or not isinstance(value,dict): fail(what,'HTTP-200-JSON','HTTP-'+str(status))
        return value
def endpoint(value,what):
    if not (isinstance(value,str) and value.startswith(ISSUER+'/')): fail('discovery '+what,'issuer-origin-endpoint','missing-or-foreign')
    return value
def discover():
    idempotent('health',ISSUER+'/health')
    d=idempotent('authorization server discovery',ISSUER+'/.well-known/oauth-authorization-server')
    if d.get('issuer')!=ISSUER: fail('discovery issuer',ISSUER,'other')
    r=idempotent('protected resource discovery',ISSUER+'/.well-known/oauth-protected-resource/mcp')
    if r.get('resource')!=ISSUER+'/mcp': fail('protected resource',ISSUER+'/mcp','other')
    return endpoint(d.get('token_endpoint'),'token_endpoint')
def refresh(c,token_url):
    # The refresh grant is NEVER retried: a lost response may already have rotated the family.
    try: status,t=send(token_url,form={'grant_type':'refresh_token','client_id':c['mcp_client_id'],'refresh_token':c['mcp_refresh_token'],'resource':c['mcp_resource']})
    except Transport: fail('refresh grant','HTTP-200','transport-error-not-retried')
    return status,t
c=credentials()
token_url=discover()
# Durable single-attempt marker BEFORE the first grant request: no guard or close re-runs a started revoke.
fd=os.open(str(proof/'dcr-probe-revoke-attempted.txt'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try: os.write(fd,b'started\n'); os.fsync(fd)
finally: os.close(fd)
# Replay revocation (oidc-provider 9.12.2): each request exactly once, never retried.
def grant(token,step):
    try: return send(token_url,form={'grant_type':'refresh_token','client_id':c['mcp_client_id'],'refresh_token':token,'resource':c['mcp_resource']})
    except Transport: unproven(step+' got transport-error-not-retried',c['mcp_client_id'])
def rejected(status,t): return status==400 and isinstance(t,dict) and t.get('error')=='invalid_grant'
def keep(t):
    # Any token the server still issues is persisted atomically for HezLead before reporting.
    if isinstance(t,dict) and isinstance(t.get('refresh_token'),str) and 0<len(t['refresh_token'])<=16384:
        c['mcp_refresh_token']=t['refresh_token']; persist(c)
status,t=grant(c['mcp_refresh_token'],'step 1 rotation refresh')
if rejected(status,t):
    # An unknown, expired or destroyed held token is rejected without revoking a surviving grant:
    # two rejections of the same token never prove anything.
    unproven('step 1 rotation refresh got HTTP-400-invalid_grant; the held token cannot prove the family revoked',c['mcp_client_id'])
elif status==200 and isinstance(t,dict) and isinstance(t.get('refresh_token'),str) and 0<len(t['refresh_token'])<=16384 and t['refresh_token']!=c['mcp_refresh_token']:
    old=c['mcp_refresh_token']; keep(t)
    status,t=grant(old,'step 2 consumed-token replay')
    if not rejected(status,t):
        keep(t); unproven('step 2 consumed-token replay expected HTTP-400-invalid_grant got HTTP-'+str(status),c['mcp_client_id'])
else:
    keep(t); unproven('step 1 rotation refresh expected HTTP-200-new-token-or-400-invalid_grant got HTTP-'+str(status),c['mcp_client_id'])
status,t=grant(c['mcp_refresh_token'],'step 3 proof refresh')
if not rejected(status,t):
    keep(t); unproven('step 3 proof refresh expected HTTP-400-invalid_grant got HTTP-'+str(status),c['mcp_client_id'])
(proof/'dcr-probe-revoked.json').write_text(json.dumps({'client_id':c['mcp_client_id'],'revoked':True,'proof':'refresh rejected'},sort_keys=True)+'\n')
print('PASS ai-w2-revoke-probes: DCR probe grant family revoked; refresh rejected')
PY
```

```sh
# step: ai-w2-apply
# readonly: no
# host: box root; one transaction per unchanged migration, no retries
set -euo pipefail
test "$WINDOW" = W2
# Every exit from here revokes a staged DCR probe grant (the block itself skips when nothing is staged,
# and never re-runs a started revoke).
w2_probe_exit() {
 local status=$?
 trap - EXIT
 # The guard runs only on an unfinished block; bash reports 0 for a ${VAR:?} exit, so force a failure status.
 test "$status" != 0 || status=1
 # Subshell: a failing revoke must reach this message even though the block re-enables set -e.
 ( ai_run ai-w2-revoke-probes ) || printf 'FAIL %s: DCR probe grant revoke on exit expected proven got failed; STOP\n' "$W2_GUARD_STEP" >&2
 exit "$status"
}
W2_GUARD_STEP=ai-w2-apply
trap w2_probe_exit EXIT
ai_deadline
test -f "$PROOF_DIR/lock-measurements.json"
test -f "$SECRET_STAGE/ordinary-probes.json"
# Pre-fence probe: the same routine once, BEFORE the durable fence; a failure applies nothing.
PROBE_POINT=prefence
ai_run ai-w2-between-probes
PROBE_POINT=
# Durable no-rerun fence BEFORE the first attempt (including unknown COMMIT).
( set -C; date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/apply-started.txt" )
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 ai_deadline
 python3 - "$PROOF_DIR" "$RELEASE_ROOT" "$RELEASE_SHA" "$VERSION" <<'PY'
import datetime,hashlib,json,pathlib,re,sys
p,root=map(pathlib.Path,sys.argv[1:3]); sha,version=sys.argv[3:]
assert re.fullmatch('[0-9a-f]{40}',sha)
new=json.loads((p/'new-migrations.json').read_text()); old=json.loads((p/'backfill.json').read_text())
# Backfill rows record the file sha256 at RELEASE_SHA; provenance stays in backfill-evidence.json.
assert all(r.get('evidence_kind') in ('release-record','ledger-statements','attested-baseline') for r in old), 'FAIL ai-w2-apply: backfill evidence_kind expected known-kind got other; STOP'
i=int(version[-1]); assert version=='2026100300000'+str(i) and new[i-1]['version']==version
measure=json.loads((p/'lock-measurements.json').read_text()); budget=measure['budgets'][i-1]
assert budget['migration']==i and 0<budget['expected_hold_seconds']<=budget['timeout_seconds']<=60
if i==1:
    age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(measure['measured_at'])).total_seconds()
    assert 0<=age<=300, 'FAIL stale measurements; STOP'
    assert not (p/('between-'+version+'.json')).exists()
else:
    previous=json.loads((p/('between-'+new[i-2]['version']+'.json')).read_text())
    assert previous['release_sha']==sha and previous['version']==new[i-2]['version'] and all(previous[k] is True for k in ('discovery','token_health','human_read'))
    age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(previous['at'])).total_seconds()
    assert 0<=age<=120, 'FAIL stale between-migration probes; STOP'
for r in new+old:
    file=root/('supabase/migrations/'+r['file'] if r in new else r['file'])
    assert hashlib.sha256(file.read_bytes()).hexdigest()==r['sha256'], 'FAIL migration bytes changed; STOP'
def lit(v): return "'"+v.replace("'","''")+"'"
def array(values): return 'ARRAY['+','.join(map(lit,values))+']::text[]'
timeout=str(budget['timeout_seconds'])+'s'
sql=["SET transaction_timeout="+lit(timeout)+";",'BEGIN;',"SET LOCAL lock_timeout='3s';","SET LOCAL statement_timeout="+lit(timeout)+";",'LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;']
expected=sorted([r['version'] for r in old]+[r['version'] for r in new[:i-1]])
sql.append("DO $ledger$ BEGIN IF (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM "+array(expected)+" THEN RAISE EXCEPTION 'unexpected ledger prefix'; END IF; END $ledger$;")
for l in measure['tables']:
    if i not in l['migrations']: continue
    t=l['table']; assert re.fullmatch('[a-z_]+\.[a-z_]+',t)
    mode='SHARE ROW EXCLUSIVE' if i==3 and t=='swarm.admin_grants' else l['mode']; assert mode in ('ACCESS EXCLUSIVE','SHARE ROW EXCLUSIVE','EXCLUSIVE')
    if t!='supabase_migrations.schema_migrations': sql.append('LOCK TABLE '+t+' IN '+mode+' MODE;')
    # Repeat the same bound under locks; no unbounded preflight/apply gap.
    sql.append("DO $bounds$ BEGIN IF (SELECT count(*) FROM "+t+")>"+str(l['max_rows'])+" OR pg_total_relation_size("+lit(t)+"::regclass)>"+str(l['max_bytes'])+" THEN RAISE EXCEPTION 'live table exceeded bounds'; END IF; END $bounds$;")
sql+=['\\i /release/supabase/migrations/'+new[i-1]['file'],"INSERT INTO supabase_migrations.schema_migrations(version) VALUES ("+lit(version)+");"]
if i>=4:
    # M2 creator membership is ADMIN-only. Temporarily permit SET in this
    # transaction, restore SET FALSE before commit; no persistent widening.
    sql += ['GRANT commonswarm_admin_release TO supabase_admin WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;','SET LOCAL ROLE commonswarm_admin_release;']
    records=[dict(version=version,sha256=new[i-1]['sha256'],source='release',released_sha=sha)]
    if i==4:
        records += [dict(version=r['version'],sha256=r['sha256'],source='backfill',released_sha=r['released_sha'] if r['evidence_kind']=='release-record' else sha) for r in old]
        records += [dict(version=r['version'],sha256=r['sha256'],source='backfill',released_sha=sha) for r in new[:3]]
    for r in records:
        sql.append('INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES ('+','.join(lit(r[k]) for k in ('version','sha256','source','released_sha'))+');')
    sql += ['RESET ROLE;','GRANT commonswarm_admin_release TO supabase_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;']
sql += ['COMMIT;']
(p/('apply-'+version+'.sql')).write_text('\n'.join(sql)+'\n')
(p/'current-budget.json').write_text(json.dumps(budget)+'\n')
PY
 START_SECONDS=$SECONDS
 if ! ai_db -q --file "/proof/apply-$VERSION.sql" >"$PROOF_DIR/apply-$VERSION.log"; then
  printf 'FAIL W2 apply/unknown COMMIT; STOP, retain prefix, run ai-w2-reconcile; no re-run\n' >&2
  exit 1
 fi
 APPLY_SECONDS=$((SECONDS-START_SECONDS))
 printf '%s|%s\n' "$VERSION" "$APPLY_SECONDS" >>"$PROOF_DIR/apply-durations.txt"
 python3 - "$PROOF_DIR/current-budget.json" "$APPLY_SECONDS" <<'PY'
import json,sys
assert int(sys.argv[2])<=json.load(open(sys.argv[1]))['expected_hold_seconds'], 'FAIL apply wall duration exceeded expected hold; STOP, retain commit and reconcile'
PY
 ai_run ai-w2-between-probes
done
ai_run ai-w2-revoke-probes
trap - EXIT
ai_run ai-w2-reconcile
```

```sh
# step: ai-w2-reconcile
# readonly: no
# host: box root; database read-only even after failure/unknown COMMIT
set -euo pipefail
test "$WINDOW" = W2
ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/ledger-after.txt"
CHECKSUM_PRESENT=$(ai_ro -Atq --command "SELECT to_regclass('commonswarm_ops.migration_checksums') IS NOT NULL;")
case "$CHECKSUM_PRESENT" in t|f) ;; *) exit 1;; esac
printf '%s\n' "$CHECKSUM_PRESENT" >"$PROOF_DIR/checksums-present.txt"
if test "$CHECKSUM_PRESENT" = t; then
 ai_ro -Atq --command 'SELECT version,sha256,source,released_sha FROM commonswarm_ops.migration_checksums ORDER BY version;' >"$PROOF_DIR/checksums-after.txt"
else
 : >"$PROOF_DIR/checksums-after.txt"
fi
python3 - "$PROOF_DIR" "$RELEASE_SHA" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); sha=sys.argv[2]
new=json.loads((p/'new-migrations.json').read_text()); old=json.loads((p/'backfill.json').read_text())
ledger=(p/'ledger-after.txt').read_text().splitlines(); baseline=sorted(r['version'] for r in old)
prefix=[r for r in new if r['version'] in ledger]; n=len(prefix)
assert prefix==new[:n] and ledger==sorted(baseline+[r['version'] for r in prefix]), 'FAIL non-prefix ledger; STOP'
assert ((p/'checksums-present.txt').read_text().strip()=='t')==(n>=4), 'FAIL checksum relation/ledger prefix conflict; STOP'
expected=[]
if n>=4:
    expected=['|'.join([r['version'],r['sha256'],'backfill',r['released_sha'] if r['evidence_kind']=='release-record' else sha]) for r in old]
    expected+=['|'.join([r['version'],r['sha256'],'backfill',sha]) for r in new[:3]]
    expected+=['|'.join([r['version'],r['sha256'],'release',sha]) for r in new[3:n]]
assert (p/'checksums-after.txt').read_text().splitlines()==sorted(expected), 'FAIL D2 prefix checksum readback; STOP'
(p/'schema-prefix.json').write_text(json.dumps(dict(committed=[r['version'] for r in prefix],complete=n==5,rerun_allowed=False))+'\n')
if n==5: (p/'schema-committed.txt').write_text('all five ledger rows, M4/M5 checksums and complete backfills exact\n')
else: raise SystemExit('STOP W2 incomplete committed prefix reconciled; retain it, no re-run')
PY
```

```sh
# step: ai-w2-probes
# readonly: no
# host: box root; database read-only, proof files only
set -euo pipefail
test "$WINDOW" = W2
test -f "$PROOF_DIR/schema-committed.txt"
python3 - "$PROOF_DIR" "$RELEASE_SHA" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); sha=sys.argv[2]
pre=json.loads((p/'between-prefence.json').read_text())
assert pre['version']=='prefence' and pre['release_sha']==sha and all(pre[k] is True for k in ('discovery','rotation','refreshed','token_health','human_read')), 'FAIL missing pre-fence probe; STOP'
revoked=json.loads((p/'dcr-probe-revoked.json').read_text())
assert set(revoked)=={'client_id','revoked','proof'} and revoked['revoked'] is True and revoked['proof']=='refresh rejected', 'FAIL missing DCR probe revoke proof; STOP'
for i in range(1,6):
    v='2026100300000'+str(i); r=json.loads((p/('between-'+v+'.json')).read_text())
    assert r['version']==v and r['release_sha']==sha and all(r[k] is True for k in ('discovery','token_health','human_read')), 'FAIL missing between-migration controls; STOP'
    if i==5:
        age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(r['at'])).total_seconds()
        assert 0<=age<=120, 'FAIL final W2 probes stale; STOP'
PY
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$PROOF_DIR/catalog.sql"
 test "$(ai_ro -Atq --file /proof/catalog.sql)" = t
 printf '%s catalog=t\n' "$VERSION" >>"$PROOF_DIR/catalog-after.txt"
done
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND NOT legacy_closed AND measured_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
ai_ro -Atq --command "SELECT n.nspname,p.proname,p.prosecdef,p.proconfig::text,pg_get_userbyid(p.proowner),p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2,p.oid;" >"$PROOF_DIR/functions-after.txt"
ai_ro -Atq --command "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('swarm','swarm_read','commonswarm_oauth','commonswarm_ops') ORDER BY 1,2;" >"$PROOF_DIR/relations-after.txt"
ai_ro -Atq --command 'SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcanlogin,rolbypassrls FROM pg_roles ORDER BY rolname;' >"$PROOF_DIR/roles-after.txt"
printf 'PASS W2 catalogs, ACL/RLS/search-path/owner inventory; issuance OFF\n'
printf 'PASS\n' >"$PROOF_DIR/W2-probes.txt"
```

The schema receipt must independently prove positive status resolver/foreign
denial, FK/resource/unique binding, replay TTL/cleanup, append-only audit, issuer
grants/NOINHERIT/local-role isolation, tombstone/upsert, D2 ledger atomicity and
D3 cap/count/action/security-bucket controls. Catalogs alone are insufficient.
ai-gates enforces these named controls before any schema apply.

## HezLead box block: W2 issuer credential

Run after ai-w2-reconcile/ai-w2-probes, before W2 close, or in W2b after
ai-w2b-preflight (the same two blocks; see W2b). The password is
created on the box, never printed and never copied to the Mac or 1Password
this window (HezLead's ruling). The AS format is JSON `{user,password}`.
The fresh role has no existing credential; an existing file stops this initial
provisioning. Rotation is a separate credential window alongside management.
Rollback disables login and clears the new password; it retains additive schema.
libpq's service-file parser accepts only `key=value` with no space around `=`
(release 5f64fab4 W2 RGLqZX failed its login on configparser's default
`key = value`). The block writes the issuer service file with
`space_around_delimiters=False` and byte-checks every line before use.

```sh
# step: ai-w2-issuer-credential
# readonly: no
# host: HezLead ONLY, box root, W2 schema window or W2b issuer-only window
set -euo pipefail
case "$WINDOW" in
 W2) test -f "$PROOF_DIR/schema-committed.txt" || { printf 'FAIL ai-w2-issuer-credential: W2 schema-committed.txt expected present got missing; STOP\n' >&2; exit 1; };;
 W2b)
  test -f "$PROOF_DIR/w2b-preconditions.txt" || { printf 'FAIL ai-w2-issuer-credential: W2b w2b-preconditions.txt expected present got missing; STOP\n' >&2; exit 1; }
  # Backup admission at the mutation boundary (the issuer LOGIN and credential are the W2b mutation).
  BACKUP_GATE_DIR="$PROOF_DIR"
  ( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-w2-issuer-credential: W2b backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
  unset BACKUP_GATE_DIR;;
 *) printf 'FAIL ai-w2-issuer-credential: window expected W2-or-W2b got other; STOP\n' >&2; exit 1;;
esac
ai_deadline
test ! -e /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2-issuer-credential: issuer credential file expected absent got present; STOP\n' >&2; exit 1; }
test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2-issuer-credential: issuer credential file expected absent got symlink; STOP\n' >&2; exit 1; }
# The mutation boundary: no password, full DO $issuer$ refusal set (attributes, memberships,
# creator, duplicates, exactly two, no shdepend a/o). LOGIN or NOLOGIN. A password or extra edge refuses.
ISSUER_FRESH=$(ai_ro -Atq --command "SELECT rolpassword IS NULL AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid WHERE r.rolname='commonswarm_admin_issuer' AND (parent.rolname NOT IN ('commonswarm_oauth_runtime','swarm_command') OR m.admin_option OR m.inherit_option OR NOT m.set_option)) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid WHERE r.rolname='commonswarm_admin_issuer' AND (NOT m.admin_option OR m.inherit_option OR m.set_option)) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid='commonswarm_admin_issuer'::regrole AND deptype IN ('a','o')) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole GROUP BY roleid HAVING count(*)<>1) AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole)=2 AND CASE WHEN (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) THEN NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid='commonswarm_admin_issuer'::regrole AND member=current_user::regrole) ELSE (SELECT count(*)=1 AND coalesce(bool_and(admin_option AND NOT inherit_option AND NOT set_option),false) FROM pg_catalog.pg_auth_members WHERE roleid='commonswarm_admin_issuer'::regrole AND member=current_user::regrole) END FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';") || { printf 'FAIL ai-w2-issuer-credential: issuer role readback expected success got failure; STOP\n' >&2; exit 1; }
test "$ISSUER_FRESH" = t || { printf 'FAIL ai-w2-issuer-credential: issuer role expected fresh-without-password before the credential got other; run ai-w2-issuer-rollback first; STOP\n' >&2; exit 1; }
# Ownership marker BEFORE any mutation: rollback and recovered close consult this file.
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/issuer-provisioning-attempted.txt" || { printf 'FAIL ai-w2-issuer-credential: issuer-provisioning-attempted.txt expected written got failure; STOP\n' >&2; exit 1; }
openssl rand -hex 32 >"$SECRET_STAGE/issuer-password" || { printf 'FAIL ai-w2-issuer-credential: password generation expected success got failure; STOP\n' >&2; exit 1; }
chmod 0600 "$SECRET_STAGE/issuer-password" || { printf 'FAIL ai-w2-issuer-credential: password file mode expected 0600 got failure; STOP\n' >&2; exit 1; }
python3 - "$SECRET_STAGE" <<'PY'
import base64,configparser,hashlib,hmac,json,os,pathlib,re,sys
def scram_verifier(password,salt,iterations=4096):
    # RFC 5802/7677 SCRAM-SHA-256, computed on the box: PostgreSQL stores a pre-hashed verifier as given, so the
    # plaintext never reaches the server or any server log.
    salted=hashlib.pbkdf2_hmac('sha256',password.encode(),salt,iterations)
    stored=hashlib.sha256(hmac.new(salted,b'Client Key',hashlib.sha256).digest()).digest()
    server=hmac.new(salted,b'Server Key',hashlib.sha256).digest()
    b64=lambda x: base64.b64encode(x).decode()
    return 'SCRAM-SHA-256$'+str(iterations)+':'+b64(salt)+'$'+b64(stored)+':'+b64(server)
try:
    p=pathlib.Path(sys.argv[1]); value=(p/'issuer-password').read_text().strip()
    assert re.fullmatch('[0-9a-f]{64}',value)
    (p/'issuer.json').write_text(json.dumps({'user':'commonswarm_admin_issuer','password':value})+'\n')
    verifier=scram_verifier(value,os.urandom(16))
    assert re.fullmatch(r'SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=',verifier)
    # Only the verifier goes to the database, from a 0600 mounted file; the readback compares this exact verifier
    # inside the database, so an earlier attempt's verifier cannot pass.
    (p/'issuer.sql').write_text("ALTER ROLE commonswarm_admin_issuer LOGIN PASSWORD '"+verifier+"';\n")
    (p/'issuer-readback.sql').write_text("SELECT rolcanlogin AND rolpassword='"+verifier+"' FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';\n")
    c=configparser.ConfigParser(interpolation=None); c.read(p/'service.conf')
    assert c.has_section('target'); c['target']['user']='commonswarm_admin_issuer'
    # libpq service files take key=value only: no space around the delimiter.
    with (p/'issuer-service.conf').open('w') as f: c.write(f,space_around_delimiters=False)
    for line in (p/'issuer-service.conf').read_text().splitlines():
        if line and not re.fullmatch(r'\[[a-z_]+\]',line) and not re.fullmatch(r'[a-z_]+=[^ ].*',line):
            raise SystemExit('FAIL ai-w2-issuer-credential: issuer-service.conf line expected key=value got other; STOP')
    rows=(p/'pass').read_text().splitlines(); assert len(rows)==1
    parts=rows[0].split(':'); assert len(parts)==5
    (p/'issuer-pass').write_text(':'.join(parts[:3]+['commonswarm_admin_issuer',value])+'\n')
    for name in ['issuer.json','issuer.sql','issuer-readback.sql','issuer-service.conf','issuer-pass']: (p/name).chmod(0o600)
except Exception:
    raise SystemExit('FAIL issuer credential preparation; STOP') from None
PY
# The ALTER runs from a read-only mounted file: docker run has no -i, so stdin SQL would be silently skipped (W2b 67aAId).
ai_db_secret_file "$SECRET_STAGE/issuer.sql" >"$SECRET_STAGE/issuer-alter.log" || { printf 'FAIL ai-w2-issuer-credential: issuer ALTER ROLE LOGIN expected success got failure; STOP\n' >&2; exit 1; }
# Readback BEFORE any login test: LOGIN with exactly THIS attempt's verifier (only the boolean leaves the database).
ISSUER_SCRAM=$(ai_db_secret_file "$SECRET_STAGE/issuer-readback.sql") || { printf 'FAIL ai-w2-issuer-credential: issuer verifier readback expected success got failure; STOP\n' >&2; exit 1; }
test "$ISSUER_SCRAM" = t || { printf 'FAIL ai-w2-issuer-credential: issuer LOGIN with this attempt'"'"'s SCRAM-SHA-256 verifier expected t got %s (ALTER ROLE not applied); STOP\n' "${ISSUER_SCRAM:-empty}" >&2; exit 1; }
install -o root -g 986 -m 0440 "$SECRET_STAGE/issuer.json" /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2-issuer-credential: credential install expected success got failure; STOP\n' >&2; exit 1; }
test "$(stat -c '%a %u %g' /etc/commonswarm-oauth/admin-issuer-database-credentials)" = '440 0 986' || { printf 'FAIL ai-w2-issuer-credential: credential mode expected 440-0-986 got other; STOP\n' >&2; exit 1; }
docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
 --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
 --volume "$SECRET_STAGE/issuer-service.conf:/run/service.conf:ro" \
 --volume "$SECRET_STAGE/issuer-pass:/run/pass:ro" \
 --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
 --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 -Atq \
 --command "SELECT current_user='commonswarm_admin_issuer' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;" \
 >"$SECRET_STAGE/issuer-login.result" 2>"$SECRET_STAGE/issuer-login.log" || { printf 'FAIL ai-w2-issuer-credential: TLS psql login exit status expected 0 got %s; STOP\n' "$?" >&2; exit 1; }
test "$(cat "$SECRET_STAGE/issuer-login.result")" = t || { printf 'FAIL ai-w2-issuer-credential: dedicated-role measurement expected t got non-t; STOP\n' >&2; exit 1; }
printf 'PASS issuer login; credential 0440 root:986; password stays on box\n' >"$PROOF_DIR/issuer-credential.txt"
```

```sh
# step: ai-w2-issuer-rollback
# readonly: no
# host: HezLead ONLY, box root; failed initial provisioning, not a rotation
set -euo pipefail
case "$WINDOW" in W2|W2b) ;; *) printf 'FAIL ai-w2-issuer-rollback: window expected W2-or-W2b got other; STOP\n' >&2; exit 1;; esac
# Every step fails explicitly: this block also runs as ( ai_run ai-w2-issuer-rollback ) || ..., where bash
# ignores errexit, so no step may rely on set -e (Codex round 3).
if test ! -f "$PROOF_DIR/issuer-provisioning-attempted.txt" || test -L "$PROOF_DIR/issuer-provisioning-attempted.txt"; then
 printf 'FAIL ai-w2-issuer-rollback: this window did not own issuer provisioning; live issuer left untouched; STOP\n' >&2; exit 1
fi
ai_db -q --command 'ALTER ROLE commonswarm_admin_issuer NOLOGIN PASSWORD NULL;' >/dev/null || { printf 'FAIL ai-w2-issuer-rollback: issuer ALTER ROLE expected success got failure; STOP\n' >&2; exit 1; }
if test -L /etc/commonswarm-oauth/admin-issuer-database-credentials; then printf 'FAIL ai-w2-issuer-rollback: issuer credential file expected not-symlink got symlink; STOP\n' >&2; exit 1; fi
if test -e /etc/commonswarm-oauth/admin-issuer-database-credentials; then
 test -f /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2-issuer-rollback: issuer credential file expected regular-file got other; STOP\n' >&2; exit 1; }
 rm -- /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL guarded issuer cleanup refused; STOP\n' >&2; exit 1; }
fi
if test -e /etc/commonswarm-oauth/admin-issuer-database-credentials || test -L /etc/commonswarm-oauth/admin-issuer-database-credentials; then printf 'FAIL ai-w2-issuer-rollback: issuer credential file expected absent got present; STOP\n' >&2; exit 1; fi
ROLLBACK_ROLE=$(ai_ro -Atq --command "SELECT NOT rolcanlogin AND rolpassword IS NULL FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';") || { printf 'FAIL ai-w2-issuer-rollback: issuer role readback expected success got failure; STOP\n' >&2; exit 1; }
test "$ROLLBACK_ROLE" = t || { printf 'FAIL ai-w2-issuer-rollback: issuer role readback expected no-login-and-no-password got other; STOP\n' >&2; exit 1; }
printf 'PASS issuer login disabled; additive roles/grants retained\n' >"$PROOF_DIR/issuer-rollback.txt" || { printf 'FAIL ai-w2-issuer-rollback: issuer-rollback.txt expected written got failure; STOP\n' >&2; exit 1; }
```

W2b runs the five forward catalogs UNMODIFIED after the credential exists: the
issuer LOGIN is back, so every row must hold, with no accepted failure. A false
or failed catalog runs ai-w2-issuer-rollback (LOGIN off, password cleared,
credential file removed) and STOPs; the window can then only close recovered.

```sh
# step: ai-w2b-forward-catalogs
# readonly: no
# host: HezLead box root, W2b after ai-w2-issuer-credential; database read-only; on failure runs ai-w2-issuer-rollback
set -euo pipefail
test "$WINDOW" = W2b || { printf 'FAIL ai-w2b-forward-catalogs: window expected W2b got other; STOP\n' >&2; exit 1; }
ai_deadline
test -f "$PROOF_DIR/issuer-credential.txt" || { printf 'FAIL ai-w2b-forward-catalogs: issuer-credential.txt expected present got missing; STOP\n' >&2; exit 1; }
test ! -e "$PROOF_DIR/w2b-forward-catalogs.txt" || { printf 'FAIL ai-w2b-forward-catalogs: w2b-forward-catalogs.txt expected absent got present; STOP\n' >&2; exit 1; }
W2B_FORWARD_FAILED=
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$PROOF_DIR/catalog.sql"
 W2B_FORWARD=$(ai_ro -Atq --file /proof/catalog.sql) || W2B_FORWARD=error
 if test "$W2B_FORWARD" != t; then W2B_FORWARD_FAILED=$VERSION; break; fi
done
if test -n "$W2B_FORWARD_FAILED"; then
 printf 'FAIL ai-w2b-forward-catalogs: forward catalog %s expected t got other; running ai-w2-issuer-rollback; STOP\n' "$W2B_FORWARD_FAILED" >&2
 ( ai_run ai-w2-issuer-rollback ) || printf 'FAIL ai-w2b-forward-catalogs: issuer rollback expected PASS got failure; STOP\n' >&2
 exit 1
fi
printf 'PASS W2b forward catalogs: all five true after the issuer credential\n' >"$PROOF_DIR/w2b-forward-catalogs.txt"
printf 'PASS ai-w2b-forward-catalogs: all five forward catalogs true\n'
```


## W2b: issuer-only window after a W2 issuer failure

Release 5f64fab4 W2 RGLqZX committed and reconciled all five migrations, then
ai-w2-issuer-credential failed (libpq rejected the `key = value` issuer service
file) and ai-w2-issuer-rollback passed: LOGIN disabled, password cleared,
credential file removed. W2 cannot run again (apply fence). W2b provisions only
the issuer credential, at the release that W3–W7 will use. It has no DCR probe
grant, no backfill and no schema write; ai-db-session's ledger baseline is the
post-W2 ledger. INPUTS binds the W2 proof directory by `w2_release_sha` and
`w2_window_id` (W2 may have run at an earlier release). Read-only
preconditions, each FAIL...STOP: a fresh backup gate in this window; the bound
W2 window's retained proofs are valid by CONTENT (ai-w2b-proof-check below:
inputs.json binding, closed.txt and its close receipt validated by
ai-live-controls, the exact schema-committed.txt, W2-probes.txt and
dcr-probe-revoked.json bytes); every ledger version has its checksum row and the
five 20261003 rows equal the migration files of THIS release archive; the five
forward catalogs hold (20261003000002-001 only for the issuer LOGIN, which the W2
rollback removed; its other role attributes are a precondition row);
the ledger holds all five 20261003 versions and nothing later
(`deploy/release-proofs/item-ai/w2b-preconditions.sql`); the issuer role exists,
NOLOGIN, without a password; the credential file is absent. Then the SAME
ai-w2-issuer-credential block runs with the W2b PROOF_DIR; on failure,
ai-w2-issuer-rollback and a recovered close. After the credential,
ai-w2b-forward-catalogs runs the five forward catalogs unmodified against the
live database; each must be true (no accepted failure), or it runs the issuer
rollback and STOPs. A successful close requires issuer-credential.txt and
w2b-forward-catalogs.txt. The order is W2b, W3, then W4, W5, W6 and W7; W2b checks
no state of any later or earlier code window. W6 binds this proof by its
required `w2b_release_sha` and `w2b_window_id` inputs; the W2b may have run at
an earlier release (W2b yYGHEd ran at a5cb8251, and a W2b cannot run again once
the issuer has LOGIN). ai-w6-issuer-live then re-verifies the credential live.

```sh
# step: ai-w2b-preflight
# readonly: no
# host: HezLead box root; database read-only, writes proof files only
set -euo pipefail
test "$WINDOW" = W2b || { printf 'FAIL ai-w2b-preflight: window expected W2b got other; STOP\n' >&2; exit 1; }
ai_deadline
BACKUP_GATE_DIR="$PROOF_DIR"
( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-w2b-preflight: W2b: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
unset BACKUP_GATE_DIR
test -f "$PROOF_DIR/ordinary-before.json"
test -f "$PROOF_DIR/consent-pre-W1.json" || { printf 'FAIL ai-w2b-preflight: retained consent receipt expected consent-pre-W1.json got missing; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-before.json" "$PROOF_DIR/consent-pre-W1.json" before no ai-w2b-preflight <<'PY' || { printf 'FAIL ai-w2b-preflight: retained before receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
# The bound W2's retained proofs, by CONTENT, through the shared validator.
PROOF_CHECK_KIND=W2
W2_BINDING=$(ai_run ai-w2b-proof-check) || { printf 'FAIL ai-w2b-preflight: bound W2 proofs expected valid got refused; STOP\n' >&2; exit 1; }
unset PROOF_CHECK_KIND
printf '%s\n' "$W2_BINDING" >"$PROOF_DIR/w2-binding.json"
printf 'PASS ai-w2b-preflight: bound W2 proofs valid: %s\n' "$W2_BINDING"
test ! -e /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2b-preflight: issuer credential file expected absent got present; STOP\n' >&2; exit 1; }
test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w2b-preflight: issuer credential file expected absent got symlink; STOP\n' >&2; exit 1; }
printf '\\i /release/deploy/release-proofs/item-ai/w2b-preconditions.sql\nSELECT :\x27w2b_ok\x27::boolean;\n' >"$PROOF_DIR/w2b-preconditions.sql"
W2B_OK=$(ai_ro -Atq --file /proof/w2b-preconditions.sql) || { printf 'FAIL ai-w2b-preflight: preconditions query expected success got failure; STOP\n' >&2; exit 1; }
test "$W2B_OK" = t || { printf 'FAIL ai-w2b-preflight: ledger five-20261003-nothing-later and NOLOGIN issuer without password expected t got other; STOP\n' >&2; exit 1; }
# Checksums, read-only: every ledger version has exactly one checksum row, and the five 20261003 rows equal the
# migration files of THIS release archive (M1-M3 backfill, M4-M5 release, recorded at the bound W2's release).
ai_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/w2b-ledger.txt" || { printf 'FAIL ai-w2b-preflight: ledger read expected success got failure; STOP\n' >&2; exit 1; }
ai_ro -Atq --command 'SELECT version,sha256,source,released_sha FROM commonswarm_ops.migration_checksums ORDER BY version;' >"$PROOF_DIR/w2b-checksums.txt" || { printf 'FAIL ai-w2b-preflight: checksum read expected success got failure; STOP\n' >&2; exit 1; }
python3 - "$RELEASE_ROOT" "$PROOF_DIR" "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,sys
root,proof=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]); w2sha=json.load(open(sys.argv[3]))['w2_release_sha']
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w2b-preflight: '+what+' expected '+expected+' got '+got+'; STOP')
ledger=(proof/'w2b-ledger.txt').read_text().splitlines()
rows=[r.split('|') for r in (proof/'w2b-checksums.txt').read_text().splitlines()]
need(all(len(r)==4 for r in rows) and [r[0] for r in rows]==ledger,'checksum rows','one-per-ledger-version','other')
for i in range(1,6):
    v='2026100300000'+str(i); files=list((root/'supabase/migrations').glob(v+'_*.sql'))
    need(len(files)==1,v+' migration file in this release','one','other')
    expected=[v,hashlib.sha256(files[0].read_bytes()).hexdigest(),'backfill' if i<=3 else 'release',w2sha]
    need(expected in rows,v+' checksum row','release-file-sha256-'+expected[2]+'-at-w2_release_sha','other')
print('PASS ai-w2b-preflight: '+str(len(rows))+' checksum rows match the ledger; five W2 rows equal this release archive')
PY
# Forward catalogs by failed-check label. Every row holds, except one: 20261003000002-001 also requires the issuer
# LOGIN that the W2 issuer rollback removed and W2b restores (its other attributes are w2b-preconditions.sql rows).
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-catalog.sql\nSELECT :\x27catalog_ok_failed_checks\x27;\n' "$VERSION" >"$PROOF_DIR/catalog.sql"
 W2B_CATALOG_FAILED=$(ai_ro -Atq --file /proof/catalog.sql) || { printf 'FAIL ai-w2b-preflight: forward catalog %s query expected success got failure; STOP\n' "$VERSION" >&2; exit 1; }
 case "$VERSION:$W2B_CATALOG_FAILED" in
  *:|20261003000002:20261003000002-001-commonswarm_admin_issuer) ;;
  *) printf 'FAIL ai-w2b-preflight: forward catalog %s expected all-rows-true (0002: only the issuer LOGIN row) got failed checks %s; STOP\n' "$VERSION" "$W2B_CATALOG_FAILED" >&2; exit 1;;
 esac
done
W2B_ISSUANCE_OFF=$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-w2b-preflight: cutover state query expected success got failure; STOP\n' >&2; exit 1; }
test "$W2B_ISSUANCE_OFF" = t || { printf 'FAIL ai-w2b-preflight: admin issuance expected OFF got other; STOP\n' >&2; exit 1; }
printf 'PASS W2b preconditions: backup gate, bound W2 proofs, ledger, checksums and forward catalogs exact; issuer NOLOGIN without password; credential absent; issuance OFF\n' >"$PROOF_DIR/w2b-preconditions.txt"
printf 'PASS ai-w2b-preflight\n'
```

The shared proof validator below is the ONE reader of a retained window's proof
files for W2b. ai-w2b-preflight runs it on the bound W2 (`PROOF_CHECK_KIND=W2`);
ai-w6-activation-checks runs it on the bound W2b (`PROOF_CHECK_KIND=W2b`). It
checks CONTENTS, never presence alone: the exact bytes each plan writer writes,
the window's own inputs.json binding, the close record, and the retained
ordinary receipt through the plan's own ai-live-controls validator with that
window's inputs, consent copy and verified release archive
(`/tmp/admin-issuance-<release_sha>-<window_id>.tar`, retained on the box). A
W2 closed before `close-result.json` existed derives its result from its single
retained after/recovery receipt; a W2b must carry `close-result.json` with result
success, the exact preconditions and issuer-credential lines, and no
`issuer-rollback.txt`.

```sh
# step: ai-w2b-proof-check
# readonly: yes
# host: box root; run through ai_run by ai-w2b-preflight (bound W2) and ai-w6-activation-checks (bound W2b); prints one JSON binding line
set -euo pipefail
: "${PROOF_CHECK_KIND:?FAIL ai-w2b-proof-check: PROOF_CHECK_KIND expected W2-or-W2b got unset; STOP}"
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_CHECK_KIND" <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,kind=sys.argv[1:4]
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w2b-proof-check: '+what+' expected '+expected+' got '+got+'; STOP')
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
def strict_json(raw,label):
    try: value=json.loads(raw)
    except ValueError: value=None
    need(isinstance(value,dict),label,'JSON-object','other')
    need(raw==(json.dumps(value,sort_keys=True)+'\n').encode(),label+' bytes','exact-sorted-JSON-line','other')
    return value
need(kind in ('W2','W2b'),'PROOF_CHECK_KIND','W2-or-W2b','other')
d=json.load(open(inputs))
if kind=='W2':
    need(d.get('window')=='W2b','checking window for a W2 proof','W2b','other'); sha,wid=d.get('w2_release_sha'),d.get('w2_window_id')
else:
    need(d.get('window')=='W6','checking window for a W2b proof','W6','other'); sha,wid=d.get('w2b_release_sha'),d.get('w2b_window_id')
need(isinstance(sha,str) and re.fullmatch('[0-9a-f]{40}',sha) is not None and isinstance(wid,str) and re.fullmatch('[A-Za-z0-9]{6}',wid) is not None,'INPUTS '+kind+' binding','full-sha-and-window-id','missing-or-other')
w=pathlib.Path('/home/commonswarm/admin-issuance/release-proofs/'+sha+'-'+kind+'-'+wid)
need(w.is_dir() and not w.is_symlink() and w.resolve()==w,kind+' proof directory','directory','missing-or-symlink')
def raw(name):
    data=read_regular(str(w/name)); need(data is not None,kind+' '+name,'regular-file','missing-or-not-regular'); return data
try: i=json.loads(raw('inputs.json'))
except ValueError: i=None
need(isinstance(i,dict) and i.get('window')==kind and i.get('release_sha')==sha and i.get('window_id')==wid,kind+' inputs.json','window-'+kind+'-bound-release-and-window-id','mismatch')
closed=raw('closed.txt')
need(re.fullmatch(rb'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n',closed) is not None,kind+' closed.txt','one-UTC-close-time-line','other')
record=read_regular(str(w/'close-result.json'))
if record is not None:
    r=strict_json(record,kind+' close-result.json')
    need(set(r)=={'release_sha','window','window_id','result','closed_at'} and r['release_sha']==sha and r['window']==kind and r['window_id']==wid,kind+' close-result.json binding','exact-keys-bound-to-inputs','other')
    need(r['closed_at']+'\n'==closed.decode() and r['result'] in ('success','recovered'),kind+' close-result.json result','success-or-recovered-at-closed.txt','other')
    result=r['result']
else:
    # A W2 that closed before close-result.json existed: its single retained close receipt is its result.
    need(kind=='W2',kind+' close-result.json','regular-file','missing-or-not-regular')
    found=[res for res,f in (('success','ordinary-after.json'),('recovered','ordinary-recovery.json')) if read_regular(str(w/f)) is not None]
    need(len(found)==1,'W2 close receipt','exactly-one-of-after-or-recovery',str(len(found)))
    result=found[0]
if kind=='W2b': need(result=='success','W2b close result','success',result)
phase='after' if result=='success' else 'recovery'
raw('ordinary-'+phase+'.json'); raw('consent-pre-W1.json')
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,'ai-w2b-proof-check').decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
need(len(found)==1,'ai-live-controls block','one','other')
env=dict(os.environ,INPUTS_FILE=str(w/'inputs.json'),BOX_ARCHIVE_PATH='/tmp/admin-issuance-'+sha+'-'+wid+'.tar',PROOF_DIR=str(w),
         LIVE_CONTROLS_FILE=str(w/('ordinary-'+phase+'.json')),CONSENT_RECEIPT_FILE=str(w/'consent-pre-W1.json'),LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN='no')
need(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env,stdout=subprocess.DEVNULL).returncode==0,kind+' ordinary-'+phase+'.json','valid-bound-live-controls-receipt','refused')
if kind=='W2':
    need(raw('schema-committed.txt')==b'all five ledger rows, M4/M5 checksums and complete backfills exact\n','W2 schema-committed.txt','exact-reconcile-line','other')
    need(raw('W2-probes.txt')==b'PASS\n','W2 W2-probes.txt','exact-PASS-line','other')
    v=strict_json(raw('dcr-probe-revoked.json'),'W2 dcr-probe-revoked.json')
    need(set(v)=={'client_id','proof','revoked'} and isinstance(v['client_id'],str) and bool(v['client_id']) and v['proof']=='refresh rejected' and v['revoked'] is True,'W2 dcr-probe-revoked.json','client_id-refresh-rejected-revoked-true','other')
else:
    need(raw('w2b-preconditions.txt')==b'PASS W2b preconditions: backup gate, bound W2 proofs, ledger, checksums and forward catalogs exact; issuer NOLOGIN without password; credential absent; issuance OFF\n','W2b w2b-preconditions.txt','exact-preconditions-line','other')
    need(raw('issuer-credential.txt')==b'PASS issuer login; credential 0440 root:986; password stays on box\n','W2b issuer-credential.txt','exact-issuer-login-line','other')
    need(raw('w2b-forward-catalogs.txt')==b'PASS W2b forward catalogs: all five true after the issuer credential\n','W2b w2b-forward-catalogs.txt','exact-forward-catalogs-line','other')
    need(not (w/'issuer-rollback.txt').exists() and not (w/'issuer-rollback.txt').is_symlink(),'W2b issuer-rollback.txt','absent','present')
print(json.dumps({'kind':kind,'release_sha':sha,'window_id':wid,'result':result,'closed_at':closed.decode().strip()},sort_keys=True))
PY
```


## W3: OAuth code release, ordinary MCP ON, issuance admin activation OFF

W3 keeps ordinary MCP ON with the management overlay. It omits the
admin-issuer overlay and leaves the activation environment variable unset. All baseline Compose files must be exactly the two reviewed base and
management files. No unreviewed override is silently dropped. Store resolved
config and diagnostics only inside SECRET_STAGE. Source and image identity
are independently checked; local image ID is an immutable sha256 reference.

```sh
# step: ai-w3-preflight
# readonly: no
# host: box root; config snapshots only
set -euo pipefail
test "$WINDOW" = W3
ai_deadline
test -f "$PROOF_DIR/ordinary-before.json"
test -f "$PROOF_DIR/consent-pre-W1.json" || { printf 'FAIL ai-w3-preflight: retained consent receipt expected consent-pre-W1.json got missing; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-before.json" "$PROOF_DIR/consent-pre-W1.json" before no ai-w3-preflight <<'PY' || { printf 'FAIL ai-w3-preflight: retained before receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
BASELINE_OAUTH_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_oauth_sha"])' "$INPUTS_FILE")
OLD_OAUTH=/home/commonswarm/oauth/releases/$BASELINE_OAUTH_SHA
NEW_OAUTH=/home/commonswarm/oauth/releases/$RELEASE_SHA
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' commonswarm-oauth-oauth-1)" = "$OLD_OAUTH/deploy/mcp-auth/compose.yaml,$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" || { printf 'FAIL ai-w3-preflight: active Compose files expected baseline-base-and-management got mismatch; STOP\n' >&2; exit 1; }
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" "$RELEASE_ROOT/deploy/mcp-auth/compose.yaml" || { printf 'FAIL ai-w3-preflight: compose.yaml bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
cmp -s "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" "$RELEASE_ROOT/deploy/mcp-auth/compose.management.yaml" || { printf 'FAIL ai-w3-preflight: compose.management.yaml bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
python3 - /etc/commonswarm-oauth/service.env <<'PY'
import pathlib,sys
rows=pathlib.Path(sys.argv[1]).read_text().splitlines()
assert not any(r.split('=',1)[0] in ('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE') for r in rows), 'FAIL W3 admin env must be unset; STOP'
PY
# Trees of other releases are ignored with evidence; the Compose label check above proves the live service uses OLD_OAUTH.
python3 - /home/commonswarm/oauth "$BASELINE_OAUTH_SHA" "$RELEASE_SHA" "$PROOF_DIR/oauth-releases-inventory.json" <<'PY' || { printf 'FAIL ai-w3-preflight: OAuth release inventory expected current-on-baseline got other; STOP\n' >&2; exit 1; }
import json,os,sys
base,old,new,out=sys.argv[1:5]
if os.path.realpath(os.path.join(base,'current'))!=os.path.join(base,'releases',old): raise SystemExit(1)
names=sorted(os.listdir(os.path.join(base,'releases')))
with open(out,'x') as f: f.write(json.dumps({'baseline':old,'release':new,'current':old,'other_releases_ignored':[n for n in names if n not in (old,new)]},sort_keys=True)+'\n')
PY
test ! -e "$NEW_OAUTH" || { printf 'FAIL ai-w3-preflight: new OAuth release directory expected absent got present; a W3 at this release left it without a completed rollback: run ai-w3-rollback in this window (it moves the tree to /home/commonswarm/oauth/failed-attempts/<release_sha>-W3-<this window_id>), close recovered, then open a new W3 window; STOP\n' >&2; exit 1; }
test ! -L "$NEW_OAUTH" || { printf 'FAIL ai-w3-preflight: new OAuth release directory expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir -p "$NEW_OAUTH"
cp -a "$RELEASE_ROOT/." "$NEW_OAUTH/"
printf 'PASS W3 baseline Compose exact; schema present; admin activation OFF\n'
```

```sh
# step: ai-w3-build
# readonly: no
# host: box root; build once, CPU-capped
set -euo pipefail
test "$WINDOW" = W3
ai_deadline
IMAGE_TAG=commonswarm-oauth:release-$RELEASE_SHA
CACHED=$(docker image ls --no-trunc --quiet --filter "reference=$IMAGE_TAG")
if test -n "$CACHED"; then
 IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
 test "$IMAGE" = "$CACHED"
else
 test "$(docker info --format '{{.CPUCfsPeriod}} {{.CPUCfsQuota}}')" = 'true true' || { printf 'FAIL ai-w3-build: CPU cap support expected true-true got unsupported; STOP\n' >&2; exit 1; }
 DOCKER_BUILDKIT=0 nice -n 15 docker build --pull=false \
  --cpu-period=100000 --cpu-quota=300000 --tag "$IMAGE_TAG" \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --file "$NEW_OAUTH/services/mcp-auth/Dockerfile" "$NEW_OAUTH" >"$SECRET_STAGE/build.log" 2>&1
 IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
fi
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$RELEASE_SHA" || { printf 'FAIL ai-w3-build: image source label expected release-sha got mismatch; STOP\n' >&2; exit 1; }
printf '%s\n' "$IMAGE" >"$PROOF_DIR/oauth-image.id"
docker run --rm --network none --entrypoint node "$IMAGE" --input-type=module -e \
 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json")); if(p.dependencies["oidc-provider"]!=="9.12.2" || !fs.existsSync("src/admin-authority.generated.js")) process.exit(1)' >/dev/null 2>&1
printf 'PASS W3 CPU-capped image; immutable source label; admin activation OFF\n'
```

```sh
# step: ai-w3-apply
# readonly: no
# host: box root; existing ON configuration, one service recreation
set -euo pipefail
test "$WINDOW" = W3
ai_deadline
test ! -e "$PROOF_DIR/oauth-attempted.txt"
cmp -s /etc/commonswarm-oauth/compose.env "$SECRET_STAGE/compose.env" || { printf 'FAIL ai-w3-apply: compose.env bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" || { printf 'FAIL ai-w3-apply: service.env bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
python3 - "$SECRET_STAGE/compose.env" "$PROOF_DIR/oauth-image.id" "$SECRET_STAGE/compose.new.env" <<'PY'
import pathlib,re,sys
source=pathlib.Path(sys.argv[1]).read_text(); image=pathlib.Path(sys.argv[2]).read_text().strip()
assert re.fullmatch('sha256:[0-9a-f]{64}',image)
assert len(re.findall(r'^MCP_OAUTH_IMAGE=.*$',source,re.M))==1
target=re.sub(r'^MCP_OAUTH_IMAGE=.*$','MCP_OAUTH_IMAGE='+image,source,flags=re.M)
pathlib.Path(sys.argv[3]).write_text(target)
PY
chmod 0600 "$SECRET_STAGE/compose.new.env"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/oauth-attempted.txt"
install -o root -g root -m 0600 "$SECRET_STAGE/compose.new.env" /etc/commonswarm-oauth/compose.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" -f "$NEW_OAUTH/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/recreate.log" 2>&1
ln -sfT "$NEW_OAUTH" /home/commonswarm/oauth/current.admin-issuance
mv -Tf /home/commonswarm/oauth/current.admin-issuance /home/commonswarm/oauth/current
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
W3_RUNNING_IMAGE=$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)
W3_EXPECTED_IMAGE=$(cat "$PROOF_DIR/oauth-image.id")
test "$W3_RUNNING_IMAGE" = "$W3_EXPECTED_IMAGE"
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
printf 'PASS W3 applied; require all probes before close\n'
```

```sh
# step: ai-w3-probes
# readonly: probe
# host: Mac outside ingress; protected values never printed
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
for base in ['https://mcp.commonswarm.com']:
    for method in ['GET','HEAD']:
        req=urllib.request.Request(base+'/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
        with urllib.request.urlopen(req,timeout=15) as r:
            body=r.read(4097)
            assert r.status==200 and len(body)<=4096
            assert json.loads(body)=={'state':'closed'} if method=='GET' else body==b''
print('PASS W3 GET/HEAD gate closed')
PY
```

Before W4, the live Caddy may not route `/admin/gate`. W3 must still probe the
new AS directly at loopback (ai-w3-local-gate); a public 404 is retained as
expected **unavailable ingress**, never treated as gate closed. Run public
ai-w3-probes only if baseline Caddy already serves that route; W4 makes it
mandatory with CORS. Baseline route availability is measured, never guessed.

```sh
# step: ai-w3-local-gate
# readonly: probe
# host: box root
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:3490/admin/gate',timeout=15) as r:
        assert r.status==200 and json.loads(r.read(4096))=={'state':'closed'}
except json.JSONDecodeError:
    raise SystemExit('FAIL ai-w3-local-gate: gate body expected JSON got non-JSON; STOP') from None
except AssertionError:
    raise SystemExit('FAIL ai-w3-local-gate: gate status/body expected HTTP-200-and-closed got mismatch; STOP') from None
print('PASS local AS /admin/gate closed')
PY
printf 'PASS\n' >"$PROOF_DIR/W3-probes.txt"
```

Same-version retry (HezLead/Tom ruling, frozen bundle). A failed W3 must leave
no tree at `/home/commonswarm/oauth/releases/<release_sha>`: ai-w3-rollback
restores the baseline, then runs ai-release-aside, which moves that tree to
`/home/commonswarm/oauth/failed-attempts/<release_sha>-W3-<window_id>` (parent
root 0700, same filesystem, one rename, evidence `oauth-aside.json` retained).
A recovered W3 close requires the tree absent and `current` on the baseline.
ai-w3-preflight therefore admits exactly one state, tree absent, and refuses a
present tree with the exact recovery instruction. It does not move it: under
these rules a present tree means an unfinished rollback, which a human must
look at, and a preflight move would collide with this window's own rollback
destination. Fewer states: one admissible precondition, one recovery path.
Trees of OTHER releases (for example the a5cb8251 tree left by W3 IkdTa6
before this rule) are ignored with evidence: ai-w3-preflight records them in
`oauth-releases-inventory.json`; the Compose label and `current` checks prove
nothing references them. Their retention is a separate assignment.

```sh
# step: ai-release-aside
# readonly: no
# host: box root; run through ai_run by ai-w3-rollback (RELEASE_ASIDE_PART=oauth) and ai-w4-rollback (edge), after the baseline is live again
set -euo pipefail
# Every step fails explicitly: the caller runs ( ai_run ai-release-aside ) || ..., where errexit is ignored.
case "${RELEASE_ASIDE_PART:-}" in
 oauth) ASIDE_BASE=/home/commonswarm/oauth; ASIDE_CONTAINER=commonswarm-oauth-oauth-1;;
 edge) ASIDE_BASE=/home/commonswarm/edge; ASIDE_CONTAINER=commonswarm-edge-edge-runtime-1;;
 *) printf 'FAIL ai-release-aside: RELEASE_ASIDE_PART expected oauth-or-edge got other; STOP\n' >&2; exit 1;;
esac
test ! -L "$ASIDE_BASE/failed-attempts" || { printf 'FAIL ai-release-aside: failed-attempts expected not-symlink got symlink; STOP\n' >&2; exit 1; }
install -d -o root -g root -m 0700 "$ASIDE_BASE/failed-attempts" || { printf 'FAIL ai-release-aside: failed-attempts expected root-0700-directory got failure; STOP\n' >&2; exit 1; }
test "$(stat -c '%a %u %g' "$ASIDE_BASE/failed-attempts")" = '700 0 0' || { printf 'FAIL ai-release-aside: failed-attempts mode expected 700-0-0 got other; STOP\n' >&2; exit 1; }
ASIDE_WORKDIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$ASIDE_CONTAINER") || { printf 'FAIL ai-release-aside: live container working directory expected readable got failure; STOP\n' >&2; exit 1; }
python3 - "$ASIDE_BASE" "$RELEASE_SHA" "$WINDOW" "$WINDOW_ID" "$ASIDE_WORKDIR" "$PROOF_DIR" <<'PY' || { printf 'FAIL ai-release-aside: failed-attempt tree expected moved-aside-or-absent got refused; STOP\n' >&2; exit 1; }
import datetime,json,os,pathlib,re,stat,sys
base,sha,window,wid,workdir,proof=sys.argv[1:7]
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-release-aside: '+what+' expected '+expected+' got '+got+'; STOP')
need(re.fullmatch('[0-9a-f]{40}',sha) is not None and window in ('W3','W4') and re.fullmatch('[A-Za-z0-9]{6}',wid) is not None,'release/window binding','full-sha-W3-or-W4-window-id','other')
part=os.path.basename(base)
new=os.path.join(base,'releases',sha); parent=os.path.join(base,'failed-attempts'); dest=os.path.join(parent,sha+'-'+window+'-'+wid)
record=pathlib.Path(proof)/(part+'-aside.json')
def write(moved):
    fd=os.open(str(record),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: f.write(json.dumps({'part':part,'release_sha':sha,'window':window,'window_id':wid,'from':new,'to':dest if moved else None,'moved':moved,'at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},sort_keys=True)+'\n')
if os.path.lexists(record):
    # A rerun after an earlier rollback attempt: only a consistent finished state passes.
    r=json.loads(record.read_text())
    need(not os.path.lexists(new) and (r.get('moved') is False or os.path.isdir(dest)),'existing '+record.name,'consistent-finished-aside','other')
    print('PASS ai-release-aside: already done; '+record.name+' retained'); raise SystemExit(0)
if not os.path.lexists(new):
    write(False); print('PASS ai-release-aside: no '+part+' tree at this release; nothing to move'); raise SystemExit(0)
need(not os.path.islink(new),'failed-attempt tree','directory','symlink')
need(stat.S_ISDIR(os.lstat(new).st_mode),'failed-attempt tree','directory','other')
current=os.path.realpath(os.path.join(base,'current'))
need(current!=new and not current.startswith(new+'/'),part+' current','baseline-not-the-failed-tree','failed-tree')
need(workdir!=new and not workdir.startswith(new+'/'),'live container working directory','baseline-not-the-failed-tree','failed-tree')
need(os.stat(os.path.dirname(new)).st_dev==os.stat(parent).st_dev,'failed-attempts filesystem','same-as-releases','other')
need(not os.path.lexists(dest),'aside destination','absent','present')
os.rename(new,dest)
need(not os.path.lexists(new) and os.path.isdir(dest) and not os.path.islink(dest),'moved tree','absent-at-source-directory-at-destination','other')
write(True)
print('PASS ai-release-aside: '+part+' tree moved to '+dest+'; evidence kept')
PY
```

```sh
# step: ai-w3-rollback
# readonly: no
# host: box root; deadline does not prevent recovery
set -euo pipefail
# Every step fails explicitly (a recovered close may run it as ( ai_run ai-w3-rollback ) || ..., where errexit is
# ignored), and the block derives its own paths from INPUTS: a recovery shell may not have run ai-w3-preflight.
test "$WINDOW" = W3 || { printf 'FAIL ai-w3-rollback: window expected W3 got other; STOP\n' >&2; exit 1; }
W3_BASELINE_OAUTH_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["baseline_oauth_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE") || { printf 'FAIL ai-w3-rollback: baseline_oauth_sha expected full-sha got other; STOP\n' >&2; exit 1; }
OLD_OAUTH=/home/commonswarm/oauth/releases/$W3_BASELINE_OAUTH_SHA
install -o root -g root -m 0600 "$SECRET_STAGE/compose.env" /etc/commonswarm-oauth/compose.env || { printf 'FAIL ai-w3-rollback: baseline compose.env restore expected success got failure; STOP\n' >&2; exit 1; }
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env" || { printf 'FAIL ai-w3-rollback: service.env bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OLD_OAUTH/deploy/mcp-auth/compose.yaml" -f "$OLD_OAUTH/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/rollback.log" 2>&1 || { printf 'FAIL ai-w3-rollback: baseline compose up expected success got failure; STOP\n' >&2; exit 1; }
# -T and -f: a temporary link left by an interrupted switch is replaced, never followed into a release directory.
ln -sfT "$OLD_OAUTH" /home/commonswarm/oauth/current.admin-issuance || { printf 'FAIL ai-w3-rollback: temporary current link expected created got failure; STOP\n' >&2; exit 1; }
mv -Tf /home/commonswarm/oauth/current.admin-issuance /home/commonswarm/oauth/current || { printf 'FAIL ai-w3-rollback: current switch expected success got failure; STOP\n' >&2; exit 1; }
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done' || { printf 'FAIL ai-w3-rollback: baseline OAuth health expected healthy got timeout; STOP\n' >&2; exit 1; }
W3_RUNNING_IMAGE=$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1) || { printf 'FAIL ai-w3-rollback: running image expected readable got failure; STOP\n' >&2; exit 1; }
W3_BASELINE_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_oauth_image"])' "$INPUTS_FILE") || { printf 'FAIL ai-w3-rollback: baseline_oauth_image expected readable got failure; STOP\n' >&2; exit 1; }
test "$W3_RUNNING_IMAGE" = "$W3_BASELINE_IMAGE" || { printf 'FAIL ai-w3-rollback: running image expected baseline got other; STOP\n' >&2; exit 1; }
test "$(readlink -f /home/commonswarm/oauth/current)" = "$OLD_OAUTH" || { printf 'FAIL ai-w3-rollback: oauth current expected baseline got other; STOP\n' >&2; exit 1; }
# Same-version retry: the failed attempt's tree leaves releases/<release_sha>, kept as evidence.
RELEASE_ASIDE_PART=oauth
( ai_run ai-release-aside ) || { printf 'FAIL ai-w3-rollback: failed-attempt tree expected moved-aside-or-absent got refused; STOP\n' >&2; exit 1; }
unset RELEASE_ASIDE_PART
printf 'PASS W3 rollback: baseline image and current restored; release tree aside or absent\n' >"$PROOF_DIR/W3-rollback.txt" || { printf 'FAIL ai-w3-rollback: W3-rollback.txt expected written got failure; STOP\n' >&2; exit 1; }
printf 'PASS W3 baseline image restored; verify ordinary controls before close\n'
```

## W4: edge, permanent legacy closure, operator measurement and Caddy

The canonical admin resource is **api.commonswarm.com/admin**, not an alias on
the MCP hostname. Define its snippet in the MCP Caddy fragment, import it in
the API site's routing before the API catchall, and put the credential-free
GET/HEAD `/admin/gate` on mcp.commonswarm.com where `/app` reads it. Preserve the
AS's `Access-Control-Allow-Origin: *`. Preflight compares LIVE bytes with the
expected baseline hashes. API/OAuth/MCP ingress must retain existing routes.
DPoP and DPoP-Nonce log fields are removed on both sites, alongside existing
query/cookie/auth redaction. Raw logs are never release evidence.

Before switching/recreating/rolling back edge, close DB issuance and invalidate
the measurement in a committed release-role transaction. The recycle timer is
paused only during this window and restored on success/failure. HezLead installs the marked recycle hooks before restoring the timer. They
invalidate before restart and remeasure afterward; failed measurement keeps
issuance closed. Other edge release paths must use the same marked hooks. Readiness JSON is diagnostic only.

```sh
# step: ai-w4-preflight
# readonly: no
# host: box root; files only, database read-only
set -euo pipefail
test "$WINDOW" = W4
ai_deadline
BACKUP_GATE_DIR="$PROOF_DIR"
( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-w4-preflight: W4: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
unset BACKUP_GATE_DIR
test -f "$PROOF_DIR/ordinary-before.json"
test -f "$PROOF_DIR/consent-pre-W1.json" || { printf 'FAIL ai-w4-preflight: retained consent receipt expected consent-pre-W1.json got missing; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-before.json" "$PROOF_DIR/consent-pre-W1.json" before no ai-w4-preflight <<'PY' || { printf 'FAIL ai-w4-preflight: retained before receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
BASELINE_EDGE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_edge_sha"])' "$INPUTS_FILE")
OLD_EDGE=/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA
NEW_EDGE=/home/commonswarm/edge/releases/$RELEASE_SHA
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' commonswarm-edge-edge-runtime-1)" = "$OLD_EDGE/deploy/edge-runtime/compose.yaml,$OLD_EDGE/deploy/edge-runtime/compose.override.yaml"
test -f "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" || { printf 'FAIL ai-w4-preflight: baseline compose.override.yaml expected regular-file got missing; STOP\n' >&2; exit 1; }
test ! -L "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" || { printf 'FAIL ai-w4-preflight: baseline compose.override.yaml expected not-symlink got symlink; STOP\n' >&2; exit 1; }
test ! -e "$NEW_EDGE" || { printf 'FAIL ai-w4-preflight: new edge release directory expected absent got present; a W4 at this release left it without a completed rollback: run ai-w4-rollback in this window (it moves the tree to /home/commonswarm/edge/failed-attempts/<release_sha>-W4-<this window_id>), close recovered, then open a new W4 window; STOP\n' >&2; exit 1; }
test ! -L "$NEW_EDGE" || { printf 'FAIL ai-w4-preflight: new edge release directory expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir -p "$NEW_EDGE"
cp -a "$RELEASE_ROOT/." "$NEW_EDGE/"
cp "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml" -f "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" \
 config --format json >"$SECRET_STAGE/edge-render.json" 2>"$SECRET_STAGE/render.log"
python3 - "$SECRET_STAGE/edge-render.json" "$INPUTS_FILE" <<'PY'
import json,subprocess,sys
c=json.load(open(sys.argv[1]))['services']['edge-runtime']; d=json.load(open(sys.argv[2]))
mem=c.get('mem_limit')
try: mem_bytes=int(mem)
except (TypeError,ValueError): mem_bytes=None
assert c['network_mode']=='commonswarm-net' and mem_bytes==2147483648, 'FAIL ai-w4-preflight: rendered edge mem_limit expected 2147483648 bytes got '+repr(mem)+'; STOP'
assert c['environment']['SWARM_MCP_PUBLIC_ENABLED']=='1'
assert not any(k.startswith(('SWARM_CMD_TEST_','MCP_OAUTH_TEST_')) for k in c['environment'])
live=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
image=json.loads(subprocess.check_output(['docker','image','inspect',d['baseline_edge_image']],stderr=subprocess.DEVNULL))[0]
expected=dict(x.split('=',1) for x in image['Config'].get('Env',[])); expected.update(c['environment'])
assert expected==dict(x.split('=',1) for x in live['Config']['Env']), 'FAIL effective edge environment drift; STOP'
PY
printf 'PASS W4 source, reviewed override, network/memory and ON flags\n'
```

```sh
# step: ai-w4-caddy-candidate
# readonly: no
# host: box root; candidate files only; before edge mutation
set -euo pipefail
test "$WINDOW" = W4
python3 - "$SECRET_STAGE" <<'PY'
import pathlib
p=pathlib.Path(__import__('sys').argv[1]); mcp=(p/'mcp.caddy').read_text(); api=(p/'api.caddy').read_text()
assert mcp.count('mcp.commonswarm.com {')==1 and api.count('api.commonswarm.com {')==1
assert mcp.count('import mcp_oauth_active')==1 and mcp.count('import mcp_resource_active')==1
assert 'admin_resource_active' not in mcp and 'admin_gate_active' not in mcp and 'admin_resource_active' not in api, 'FAIL existing admin route requires new reviewed baseline; STOP'
snippet='''
(admin_gate_active) {
    @admin_gate {
        method GET HEAD
        path /admin/gate
    }
    handle @admin_gate {
        reverse_proxy 127.0.0.1:3490 {
            transport http {
                dial_timeout 5s
                response_header_timeout 5s
            }
        }
    }
}
(admin_resource_active) {
    @admin_resource {
        method POST OPTIONS
        path /admin
    }
    handle @admin_resource {
        request_body {
            max_size 128KB
        }
        rewrite * /functions/v1/admin
        reverse_proxy 127.0.0.1:9000 {
            transport http {
                response_header_timeout 165s
            }
        }
    }
    @admin_metadata {
        method GET
        path /.well-known/oauth-protected-resource/admin
    }
    handle @admin_metadata {
        rewrite * /functions/v1/admin/.well-known/oauth-protected-resource
        reverse_proxy 127.0.0.1:9000
    }
    @admin_wrong_method path /admin /.well-known/oauth-protected-resource/admin
    handle @admin_wrong_method {
        header Content-Type application/json
        respond "{\\"error\\":\\"method_not_allowed\\"}" 405
    }
}
'''
mcp=mcp.replace('import mcp_oauth_active','import admin_gate_active\n\t\timport mcp_oauth_active',1)
anchor='\t@edge_functions path /functions/v1 /functions/v1/*'
assert api.count(anchor)==1
# The lexical 10-API file defines shared snippets before either site imports them.
api=snippet+api.replace(anchor,'\timport admin_resource_active\n\n'+anchor,1)
for name,body in [('mcp.new.caddy',mcp),('api.new.caddy',api)]:
    for prefix in ['request>headers','resp_headers']:
        anchor=prefix+'>Authorization delete'
        assert body.count(anchor)==1, 'FAIL ai-w4-caddy-candidate: '+name+' '+prefix+'>Authorization delete expected one got '+str(body.count(anchor))+'; STOP'
        body=body.replace(anchor,anchor+'\n\t\t\t'+prefix+'>DPoP delete\n\t\t\t'+prefix+'>Dpop delete\n\t\t\t'+prefix+'>DPoP-Nonce delete\n\t\t\t'+prefix+'>Dpop-Nonce delete',1)
    (p/name).write_text(body)
PY
# Full config candidate with imports redirected to a task-owned directory;
# validate the identical bytes before installing either live file.
mkdir "$SECRET_STAGE/sites"
cp -a /etc/caddy/sites/. "$SECRET_STAGE/sites/"
cp "$SECRET_STAGE/mcp.new.caddy" "$SECRET_STAGE/sites/20-commonswarm-mcp.caddy"
cp "$SECRET_STAGE/api.new.caddy" "$SECRET_STAGE/sites/10-commonswarm-api.caddy"
python3 - "$SECRET_STAGE" <<'PY' || exit 1
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]).resolve(strict=True); c=pathlib.Path('/etc/caddy/Caddyfile').read_text()
lines=c.splitlines(keepends=True)
imports=[(i,line.strip()) for i,line in enumerate(lines) if re.match(r'^import(?:\s|$)',line.strip())]
accepted=['import sites/*.caddy','import /etc/caddy/sites/*.caddy']
found=[line for _,line in imports]
if len(found)!=1 or found[0] not in accepted:
    raise SystemExit('FAIL ai-w4-caddy-candidate: Caddy imports expected exactly one of '+json.dumps(accepted)+' got '+json.dumps(found)+'; STOP')
# Caddy resolves relative imports against the config file's directory, not cwd:
# sites/*.caddy in <SECRET_STAGE>/Caddyfile resolves to <SECRET_STAGE>/sites/*.caddy.
# Preserve a relative import; redirect an absolute import to the resolved candidate path.
target='sites/*.caddy' if found[0]==accepted[0] else str(p/'sites/*.caddy')
i=imports[0][0]; lines[i]=lines[i].replace(found[0],'import '+target,1)
(p/'Caddyfile').write_text(''.join(lines))
PY
chmod -R go-rwx "$SECRET_STAGE"
caddy validate --config "$SECRET_STAGE/Caddyfile" --adapter caddyfile >"$SECRET_STAGE/caddy-validate.log" 2>&1 || { printf 'FAIL ai-w4-caddy-candidate: Caddy validation exit status expected 0 got %s; STOP\n' "$?" >&2; exit 1; }
printf 'PASS W4 both Caddy candidate routes validated; CORS preserved\n'
```

```sh
# step: ai-w4-apply
# readonly: no
# host: box root; issuance close/invalidate precedes every source change; Mac already ran ai-gates
(
set -euo pipefail
test "$WINDOW" = W4
ai_deadline
test ! -e "$PROOF_DIR/edge-attempted.txt"
ai_run ai-inputs
ai_run ai-gates-bind
test -f "$SECRET_STAGE/mcp.new.caddy" || { printf 'FAIL ai-w4-apply: mcp.new.caddy candidate expected present got missing; STOP\n' >&2; exit 1; }
test -f "$SECRET_STAGE/api.new.caddy" || { printf 'FAIL ai-w4-apply: api.new.caddy candidate expected present got missing; STOP\n' >&2; exit 1; }
# Backup admission at the mutation boundary: the bound, fresh receipt of THIS window.
BACKUP_GATE_DIR="$PROOF_DIR"
( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-w4-apply: W4: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
unset BACKUP_GATE_DIR
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-attempted.txt"
ai_run ai-timer-guard
systemctl stop "$EDGE_RECYCLE_TIMER"
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env"
ln -sfT "$NEW_EDGE" /home/commonswarm/edge/current.admin-issuance
mv -Tf /home/commonswarm/edge/current.admin-issuance /home/commonswarm/edge/current
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml" -f "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" \
 up -d --no-build --pull never --force-recreate edge-runtime >"$SECRET_STAGE/edge-apply.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
python3 - "$NEW_EDGE" "$INPUTS_FILE" "$PROOF_DIR/edge-measurement.json" <<'PY'
import hashlib,json,pathlib,subprocess,sys
target=pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True); d=json.load(open(sys.argv[2]))
assert str(target)==sys.argv[1]=='/home/commonswarm/edge/releases/'+d['release_sha']
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
assert c['Image']==d['baseline_edge_image'] and c['State']['Health']['Status']=='healthy'
assert c['Config']['Labels']['com.docker.compose.project.working_dir']==str(target/'deploy/edge-runtime')
assert c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648
for destination,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
    m=[m for m in c['Mounts'] if m['Destination']==destination]
    assert len(m)==1 and m[0]['Source']==str(target/rel) and m[0]['RW'] is False
archive=pathlib.Path('/tmp/admin-issuance-'+d['release_sha']+'-'+d['window_id']+'.tar')
assert hashlib.sha256(archive.read_bytes()).hexdigest()==d['archive_sha256']
# Exact deployed tracked-byte comparison, not readiness/self-attestation.
import tarfile
with tarfile.open(archive) as t:
    for member in t.getmembers():
        if member.isfile(): assert (target/member.name).read_bytes()==t.extractfile(member).read()
pathlib.Path(sys.argv[3]).write_text(json.dumps({'release_sha':d['release_sha'],'target':str(target),'mount':str(target),'image_digest':c['Image'],'artifact_digest':d['archive_sha256']},sort_keys=True)+'\n')
PY
# Separate terminal-fence approval was checked by ai-inputs, before open.
# Measurement + closure are written by the release role in this same marked switch.
python3 - "$PROOF_DIR" "$RELEASE_ROOT" "$RELEASE_SHA" "$WINDOW_ID" <<'PY'
import hashlib,json,pathlib,sys
p,root=map(pathlib.Path,sys.argv[1:3]); sha,wid=sys.argv[3:]; m=json.loads((p/'edge-measurement.json').read_text())
expected={}
for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+['2026100300000'+str(i) for i in range(1,6)]:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    expected[v]=hashlib.sha256(files[0].read_bytes()).hexdigest()
sql="BEGIN; SET LOCAL ROLE commonswarm_admin_release; SELECT commonswarm_oauth.apply_legacy_admin_fence('W4/"+wid+"/ai-w4-apply');\n"
sql+="UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,approved_edge_release_sha='"+sha+"',auth_contract_version=2,required_migrations='"+json.dumps(expected)+"'::jsonb,measured_edge_release_sha='"+sha+"',measured_edge_target='"+m['target']+"',measured_mount='"+m['mount']+"',measured_image_digest='"+m['image_digest']+"',measured_artifact_digest='"+m['artifact_digest']+"',release_generation=release_generation+1,measured_generation=release_generation+1,measured_at=statement_timestamp(),measurement_evidence_ref='W4/"+wid+"/ai-w4-apply',invalidated_at=NULL WHERE singleton; COMMIT;\n"
(p/'measure.sql').write_text(sql)
PY
ai_db -q --file /proof/measure.sql >/dev/null
EDGE_MEASUREMENT_GENERATION=$(ai_ro -Atq --command 'SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND invalidated_at IS NULL AND measured_generation=release_generation;')
python3 - "$PROOF_DIR/edge-measurement.json" "$EDGE_MEASUREMENT_GENERATION" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); m=json.loads(p.read_text())
assert sys.argv[2].isdigit() and int(sys.argv[2])>0, 'FAIL release_generation/measured_generation/invalidated_at; STOP'
m.update(generation=int(sys.argv[2]),invalidated_at=None); p.write_text(json.dumps(m,sort_keys=True)+'\n')
PY
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.caddy"
cmp -s /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.caddy"
W4_CADDYFILE_SHA256=$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')
W4_EXPECTED_CADDYFILE_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_caddyfile_sha256"])' "$INPUTS_FILE")
test "$W4_CADDYFILE_SHA256" = "$W4_EXPECTED_CADDYFILE_SHA256"
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.new.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy
install -o root -g root -m 0644 "$SECRET_STAGE/api.new.caddy" /etc/caddy/sites/10-commonswarm-api.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$SECRET_STAGE/caddy-live-validate.log" 2>&1 || { printf 'FAIL ai-w4-apply: Caddy validation exit status expected 0 got %s; STOP\n' "$?" >&2; exit 1; }
systemctl reload caddy
ai_run ai-recycle-install
printf 'Apply body completed; timer recovery still required: W4 switched and measured; legacy permanently fenced; issuance OFF\n'
)
```

```sh
# step: ai-w4-probes
# readonly: probe
# host: Mac outside ingress, Origin set; then box readback via ai-w4-readback
set -euo pipefail
python3 - <<'PY'
import json,urllib.error,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
for method in ['GET','HEAD']:
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with opener.open(req,timeout=15) as r:
        body=r.read(4097)
        try:
            assert r.status==200 and r.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in r.headers.get('Cache-Control','') and len(body)<=4096
        except AssertionError:
            raise SystemExit(f'FAIL ai-w4-probes: {method} /admin/gate status/ACAO/cache/body-length expected 200/*/no-store/<=4096 got {r.status}/'+('*' if r.headers.get('Access-Control-Allow-Origin')=='*' else 'non-wildcard-or-missing')+'/'+('no-store' if 'no-store' in r.headers.get('Cache-Control','') else 'missing-no-store')+f'/{len(body)}; Origin expected commonswarm-site got '+('commonswarm-site' if req.get_header('Origin')=='https://commonswarm.com' else 'other-or-missing')+'; STOP') from None
        try:
            assert (json.loads(body)=={'state':'closed'}) if method=='GET' else body==b''
        except json.JSONDecodeError:
            raise SystemExit(f'FAIL ai-w4-probes: {method} /admin/gate body expected closed-JSON got non-JSON; STOP') from None
        except AssertionError:
            raise SystemExit(f'FAIL ai-w4-probes: {method} /admin/gate body expected '+('closed' if method=='GET' else 'empty')+' got '+(('open' if json.loads(body)=={'state':'open'} else 'non-closed') if method=='GET' else 'nonempty')+'; STOP') from None
req=urllib.request.Request('https://api.commonswarm.com/admin',method='POST',data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',headers={'Origin':'https://commonswarm.com','Content-Type':'application/json','User-Agent':'curl/8.7.1'})
try: response=opener.open(req,timeout=15)
except urllib.error.HTTPError as error: response=error
with response:
    try: assert response.status==401 and len(response.read(4097))<=4096
    except AssertionError:
        raise SystemExit(f'FAIL ai-w4-probes: POST canonical /admin status/body-length expected 401/<=4096 got {response.status}/'+('oversized' if response.status==401 else 'not-read-status-mismatch')+'; STOP') from None
req=urllib.request.Request('https://api.commonswarm.com/.well-known/oauth-protected-resource/admin',method='GET',headers={'User-Agent':'curl/8.7.1'})
try: response=opener.open(req,timeout=15)
except urllib.error.HTTPError as error: response=error
with response:
    body=response.read(4097)
    try:
        assert response.status==200 and len(body)<=4096
        meta=json.loads(body)
        assert meta.get('resource')=='https://api.commonswarm.com/admin' and meta.get('authorization_servers')==['https://mcp.commonswarm.com']
    except (AssertionError,json.JSONDecodeError,TypeError):
        raise SystemExit('FAIL ai-w4-probes: GET /.well-known/oauth-protected-resource/admin expected 200 metadata-document got '+str(response.status)+'; STOP') from None
req=urllib.request.Request('https://api.commonswarm.com/.well-known/oauth-protected-resource/admin',method='HEAD',headers={'User-Agent':'curl/8.7.1'})
try: response=opener.open(req,timeout=15)
except urllib.error.HTTPError as error: response=error
with response:
    try: assert response.status==405 and len(response.read(4097))<=4096
    except AssertionError:
        raise SystemExit('FAIL ai-w4-probes: HEAD /.well-known/oauth-protected-resource/admin expected 405 method_not_allowed (handler is GET-only) got '+str(response.status)+'; STOP') from None
print('PASS outside GET/HEAD gate closed + CORS; canonical /admin reaches verifier; discovery GET metadata, HEAD 405')
PY
```

```sh
# step: ai-w4-readback
# readonly: no
# host: box root; database read-only, redacted receipt
set -euo pipefail
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation AND measured_edge_release_sha=approved_edge_release_sha FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
test "$(ai_ro -Atq --command "SELECT NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='swarm.admin_credentials'::regclass);" )" = t
printf 'PASS closure/measurement/ledger+checksum gate; issuance OFF\n' >"$PROOF_DIR/W4-readback.txt"
cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy "$SECRET_STAGE/mcp.new.caddy"
cmp -s /etc/caddy/sites/10-commonswarm-api.caddy "$SECRET_STAGE/api.new.caddy"
```

```sh
# step: ai-w4-rollback
# readonly: no
# host: box root; leave legacy closure permanent and issuance closed
(
set -euo pipefail
# Paths come from INPUTS: a recovery shell may not have run ai-w4-preflight.
W4_BASELINE_EDGE_SHA=$(python3 -c 'import json,re,sys; v=json.load(open(sys.argv[1]))["baseline_edge_sha"]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$INPUTS_FILE") || { printf 'FAIL ai-w4-rollback: baseline_edge_sha expected full-sha got other; STOP\n' >&2; exit 1; }
OLD_EDGE=/home/commonswarm/edge/releases/$W4_BASELINE_EDGE_SHA
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null || { printf 'FAIL ai-w4-rollback: issuance close and invalidation expected committed got failure; STOP\n' >&2; exit 1; }
ai_run ai-timer-guard || { printf 'FAIL ai-w4-rollback: timer guard expected installed got failure; STOP\n' >&2; exit 1; }
systemctl stop "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w4-rollback: recycle timer stop expected success got failure; STOP\n' >&2; exit 1; }
ai_run ai-recycle-rollback || { printf 'FAIL ai-w4-rollback: recycle rollback expected success got failure; STOP\n' >&2; exit 1; }
install -o root -g root -m 0644 "$SECRET_STAGE/mcp.caddy" /etc/caddy/sites/20-commonswarm-mcp.caddy || { printf 'FAIL ai-w4-rollback: baseline MCP Caddy restore expected success got failure; STOP\n' >&2; exit 1; }
install -o root -g root -m 0644 "$SECRET_STAGE/api.caddy" /etc/caddy/sites/10-commonswarm-api.caddy || { printf 'FAIL ai-w4-rollback: baseline API Caddy restore expected success got failure; STOP\n' >&2; exit 1; }
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$SECRET_STAGE/caddy-rollback.log" 2>&1 || { printf 'FAIL ai-w4-rollback: baseline Caddy validation expected success got failure; STOP\n' >&2; exit 1; }
systemctl reload caddy || { printf 'FAIL ai-w4-rollback: Caddy reload expected success got failure; STOP\n' >&2; exit 1; }
cmp -s /home/commonswarm/.env "$SECRET_STAGE/edge.env" || { printf 'FAIL ai-w4-rollback: edge.env bytes expected identical got different-or-unreadable; STOP\n' >&2; exit 1; }
ln -sfT "$OLD_EDGE" /home/commonswarm/edge/current.admin-issuance || { printf 'FAIL ai-w4-rollback: baseline temporary link expected replaced got failure; STOP\n' >&2; exit 1; }
mv -Tf /home/commonswarm/edge/current.admin-issuance /home/commonswarm/edge/current || { printf 'FAIL ai-w4-rollback: edge current switch expected success got failure; STOP\n' >&2; exit 1; }
COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net docker compose --project-name commonswarm-edge \
 -f "$OLD_EDGE/deploy/edge-runtime/compose.yaml" -f "$OLD_EDGE/deploy/edge-runtime/compose.override.yaml" \
 up -d --no-build --pull never --force-recreate edge-runtime >"$SECRET_STAGE/edge-rollback.log" 2>&1 || { printf 'FAIL ai-w4-rollback: baseline compose up expected success got failure; STOP\n' >&2; exit 1; }
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done' || { printf 'FAIL ai-w4-rollback: baseline edge health expected healthy got timeout-or-failure; STOP\n' >&2; exit 1; }
W4_RUNNING_IMAGE=$(docker inspect --format '{{.Image}}' commonswarm-edge-edge-runtime-1) || { printf 'FAIL ai-w4-rollback: running image expected readable got failure; STOP\n' >&2; exit 1; }
W4_BASELINE_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_edge_image"])' "$INPUTS_FILE") || { printf 'FAIL ai-w4-rollback: baseline_edge_image expected readable got failure; STOP\n' >&2; exit 1; }
test "$W4_RUNNING_IMAGE" = "$W4_BASELINE_IMAGE" || { printf 'FAIL ai-w4-rollback: running image expected baseline got other; STOP\n' >&2; exit 1; }
test "$(readlink -f /home/commonswarm/edge/current)" = "$OLD_EDGE" || { printf 'FAIL ai-w4-rollback: edge current expected baseline got other; STOP\n' >&2; exit 1; }
# Same-version retry: the failed attempt's tree leaves releases/<release_sha>, kept as evidence.
RELEASE_ASIDE_PART=edge
( ai_run ai-release-aside ) || { printf 'FAIL ai-w4-rollback: failed-attempt tree expected moved-aside-or-absent got refused; STOP\n' >&2; exit 1; }
unset RELEASE_ASIDE_PART || { printf 'FAIL ai-w4-rollback: aside part reset expected success got failure; STOP\n' >&2; exit 1; }
printf 'Apply body completed; timer recovery still required: W4 baseline source/Caddy restored; release tree aside or absent; measurement invalid; legacy remains fenced\n' || { printf 'FAIL ai-w4-rollback: completion output expected written got failure; STOP\n' >&2; exit 1; }
)
```

```sh
# step: ai-timer-guard
# readonly: no
# host: box root; source only inside the timer-owning step's subshell
set -euo pipefail
ai_timer_restore_on_exit() {
 local STEP_STATUS=$1 TIMER_STATUS
 # Recovery runs once, even on stop failure, exit, INT or TERM. Do not retry it.
 trap - EXIT INT TERM
 set +e
 ( set -euo pipefail; ai_run ai-w4-timer-recovery )
 TIMER_STATUS=$?
 if test "$TIMER_STATUS" -ne 0; then
  printf 'FAIL timer recovery; window remains open; incident requires HezLead; STOP\n' >&2
  exit 1
 fi
 exit "$STEP_STATUS"
}
trap 'ai_timer_restore_on_exit "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
```

```sh
# step: ai-w4-timer-recovery
# readonly: no
# host: box root; also available after a failed rollback; not a close receipt
set -euo pipefail
# Also runs as ( ai_run ai-w4-timer-recovery ) || ..., where errexit is ignored: every step fails explicitly.
systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w4-timer-recovery: recycle timer start expected success got failure; STOP\n' >&2; exit 1; }
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w4-timer-recovery: recycle timer expected active got inactive; STOP\n' >&2; exit 1; }
printf 'Timer restored; window remains open until service recovery is verified\n'
```

The timer-stopping blocks are ai-w4-apply, ai-w4-rollback, ai-edge-refresh,
ai-w6-activation-apply, ai-w6-finish and ai-w7-timer-hold. ai-w4-apply and ai-w4-rollback install
ai-timer-guard **before** the stop in their own subshell, so nested sourced
blocks cannot remove the caller's EXIT trap. ai-edge-refresh re-arms on every
exit. W6 (HezLead ruling) keeps the timer STOPPED from ai-w6-activation-apply
until ai-w6-finish: a failed apply re-arms it at once; ai-w6-finish re-arms it
on every exit; ai-w6-activation-rollback (and so ai-emergency-close) re-arms it;
and every ai-close STOPs with a report while the timer is inactive.
On success, command failure, explicit exit, INT or TERM the trap invokes the
complete ai-w4-timer-recovery block and preserves the failure status. Recovery
failure is an open incident, never a close receipt. SIGKILL or loss of the host
cannot run a shell trap: HezLead must run ai-w4-timer-recovery after reconnect.
ai-recycle-rollback requires the caller's stopped timer and never stops it
itself. No other marked block stops a timer or service. ai-close independently
requires the measured recycle timer active for success **and** recovered close,
including W6; a failed body can close only after the existing recovery probes.

## HezLead box block: measured six-hour recycle

In preflight HezLead executes ai-recycle-inventory, which enumerates timers,
reads each timer's Triggers and matches the box's recycle service, then supplies the exact
unit names plus SHA-256 of `systemctl cat <service>` including its final newline
as `edge_recycle_timer`, `edge_recycle_service`, `edge_recycle_sha256`.
These are measured inputs, never presumed unit names. ai-box-preflight binds
and validates them. Each later window must remeasure the unit including the
drop-in. Install in W4 while the timer is stopped, before restoring it.
The hook closes issuance/increments generation in ExecStartPre, before the
existing restart, then remeasures target, image, health, immutable mounts and
all archive bytes in ExecStartPost. Only a previously open, still-approved
release can reopen. When the after hook fails it reads the row back: only a
confirmed CLOSED row gives "issuance CLOSED" and a NONSECRET watch marker for HezLead: one journal line with tag
`commonswarm-admin-recycle` and one appended line in the root-owned 0644
`/var/lib/commonswarm-release/admin-issuance-closed.log`, both the JSON
`{"at","unit","event":"admin-issuance-closed-needs-reactivation","approved_edge_release_sha","measured_edge_release_sha"|null,"reason"}`
(reason: recycle-config-invalid, database-session-failed, recycle-intent-invalid,
edge-measurement-failed, database-measurement-refused, or
remeasure-validation-failed from the `close` mode when it shut OPEN issuance; the unit comes from
the drop-in's `Environment=COMMONSWARM_RECYCLE_UNIT=%n`, or is
`ai-edge-remeasure`). A marker failure is reported on stderr; the close
stands. If the after hook fails once its reopen may have COMMITTED, it closes
and invalidates again (release role) and writes the CLOSED marker only when an
independent readback confirms CLOSED; otherwise it writes the same JSON with
`"event":"admin-issuance-state-unknown"` and reports "may be OPEN" (scheduled
recycle and remeasure alike). The `close` mode runs its database close before
any bookkeeping and confirms it the same way. ai-edge-remeasure exits 1 when its
failure close is confirmed CLOSED and 2 when the state is unknown; every caller
reports that result and no step claims CLOSED without it. A failure before a
readback is possible (configuration, session) or a failed before hook gives
the state-unknown line. A good recycle writes no marker. Issuance closed this
way stays closed until a W6 activation reopens it. **Post-C1 follow-up:** a lightweight
measured-reopen procedure under HezLead approval (remeasure, then reopen only
through the measured path) replaces that W6 rerun; it is not part of this
release. HezLead executes
these blocks; this preparation worker never installs or invokes a hook.

```sh
# step: ai-recycle-hook
# readonly: no
# host: box root, installed by HezLead; systemd invokes before/after
set -euo pipefail
: "${1:?before or after}"
case "$1" in before|after|close) ;; *) exit 1;; esac
umask 077
HOOK_SECRET_STAGE=$(mktemp -d /tmp/anvil-secret.XXXXXX)
chmod 0700 "$HOOK_SECRET_STAGE"
ai_hook_cleanup() {
 python3 - "$HOOK_SECRET_STAGE" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
PY
 rm -r -- "$HOOK_SECRET_STAGE" || { printf 'FAIL recycle secret cleanup refused %s; STOP\n' "$HOOK_SECRET_STAGE" >&2; return 1; }
}
trap ai_hook_cleanup EXIT
python3 - "$1" "$HOOK_SECRET_STAGE" <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys,tarfile,time
stage=pathlib.Path(sys.argv[2]); mode=sys.argv[1]
reason='recycle-config-invalid'; approved=None; measured=None; reopen_attempted=False; close_confirmed=False
def closed_marker(event='admin-issuance-closed-needs-reactivation'):
    # NONSECRET watch marker, written only AFTER the failure left issuance closed: one journal line and one
    # appended JSON line. No token, credential, connection value or database row beyond the two release SHAs.
    unit=os.environ.get('COMMONSWARM_RECYCLE_UNIT','')
    line=json.dumps({'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'unit':unit if re.fullmatch(r'[A-Za-z0-9@._:-]{1,256}',unit) else 'unknown',
        'event':event,'approved_edge_release_sha':approved,'measured_edge_release_sha':measured,'reason':reason},sort_keys=True)
    ok=True
    try: subprocess.run(['logger','-t','commonswarm-admin-recycle','--',line],check=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    except Exception: ok=False
    try:
        d='/var/lib/commonswarm-release'
        if not os.path.lexists(d): os.mkdir(d,0o755); os.chmod(d,0o755)
        assert os.path.isdir(d) and not os.path.islink(d)
        fd=os.open(d+'/admin-issuance-closed.log',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o644)
        try:
            st=os.fstat(fd); assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid()
            os.fchmod(fd,0o644); assert os.write(fd,(line+'\n').encode())==len(line)+1
        finally: os.close(fd)
    except Exception: ok=False
    if not ok: print('FAIL recycle closed-marker not fully written (journal or admin-issuance-closed.log); the close decision above stands; HezLead must check the database',file=sys.stderr)
try:
    path=pathlib.Path('/etc/commonswarm-admin-release/recycle.json')
    assert path.is_file() and not path.is_symlink() and path.stat().st_uid==0 and path.stat().st_mode & 0o777==0o600
    r=json.loads(path.read_text()); sha=r['release_sha']; target='/home/commonswarm/edge/releases/'+sha
    assert re.fullmatch('[0-9a-f]{40}',sha) and r['target']==target
    assert re.fullmatch('sha256:[0-9a-f]{64}',r['image_digest']) and re.fullmatch('[0-9a-f]{64}',r['artifact_digest'])
    archive=pathlib.Path(r['archive']); assert archive.is_file() and not archive.is_symlink()
    assert re.fullmatch(r'/tmp/admin-issuance-'+sha+r'-[A-Za-z0-9]{6}\.tar',str(archive))
    root=pathlib.Path(r['release_root']); assert str(root)=='/home/commonswarm/admin-issuance/releases/'+sha and root.resolve()==root
    approved=sha; reason='database-session-failed'
    env={k:v for k,v in os.environ.items() if k!='NODE_OPTIONS' and not k.startswith('ADMIN_SMOKE_')}; env.update(PG_SERVICE_OUTPUT=str(stage/'service.conf'),PG_PASS_OUTPUT=str(stage/'pass'),COMMONSWARM_ENV_FILE='/home/commonswarm/.env',COMMONSWARM_MIGRATION_ENV_FILE='/etc/commonswarm-release/target.env')
    with (stage/'session.log').open('w') as log:
        subprocess.run(['node',str(root/'deploy/supabase-stack/migrate/make-pg-service.mjs')],env=env,stdout=log,stderr=log,check=True)
    for name in ['service.conf','pass']: (stage/name).chmod(0o600)
    assert re.fullmatch('sha256:[0-9a-f]{64}',r['postgres_image'])
    # docker run has no -i: stdin SQL would be silently skipped, so each statement runs from a read-only mounted
    # 0600 file in this hook's private stage: a NEW file per call, fully written and closed before docker starts,
    # never rewritten (a container that outlived its client cannot see a later statement); the stage goes at exit.
    import tempfile
    def db(sql):
        fd,name=tempfile.mkstemp(prefix='statement.',suffix='.sql',dir=str(stage))
        with os.fdopen(fd,'w') as f: f.write(sql)
        os.chmod(name,0o600)
        args=['docker','run','--rm','--network','commonswarm-net','--add-host','db.commonswarm.internal:172.31.0.10','--env','PGSERVICE=target','--env','PGSERVICEFILE=/run/service.conf','--env','PGPASSFILE=/run/pass','--volume',str(stage/'service.conf')+':/run/service.conf:ro','--volume',str(stage/'pass')+':/run/pass:ro','--volume','/etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro','--volume',name+':/run/statement.sql:ro','--entrypoint','psql',r['postgres_image'],'-X','--set=ON_ERROR_STOP=1','-Atq','--file','/run/statement.sql']
        with (stage/'db.log').open('w') as log:
            return subprocess.check_output(args,stdin=subprocess.DEVNULL,text=True,stderr=log).strip()
    intent=pathlib.Path('/etc/commonswarm-admin-release/recycle-intent.json')
    def confirm_closed():
        # Independent readback: CLOSED is claimed only when the database says so.
        try: return db('SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')=='t'
        except Exception: return False
    def failure_close():
        # Release-role close (close first, then invalidate), then the readback; never a recursive hook run.
        try: was=db("BEGIN; SET LOCAL ROLE commonswarm_admin_release; SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false WHERE singleton; UPDATE commonswarm_oauth.admin_cutover_state SET invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;")
        except Exception: was=None
        return was,confirm_closed()
    if mode=='close':
        # ai-edge-remeasure's failure close: the safety transaction first, bookkeeping only after it.
        reason='remeasure-validation-failed'
        was,close_confirmed=failure_close()
        if not close_confirmed:
            closed_marker('admin-issuance-state-unknown')
            raise SystemExit('FAIL recycle hook close; issuance state UNKNOWN (close not confirmed by readback; may be OPEN); run ai-emergency-close; HezLead recovery required')
        # A CLOSED marker only when this close shut OPEN issuance; a failed after hook has already marked its own close.
        if was=='t': closed_marker()
        intent.write_text(json.dumps({'reopen':False,'generation':None})+'\n'); intent.chmod(0o600)
    elif mode=='before':
        # Stale intent can never be used after a failed/unknown pre-hook.
        intent.write_text(json.dumps({'reopen':False,'generation':None})+'\n'); intent.chmod(0o600)
        # guard_cutover_state refuses a generation change while issuance is open: close, then invalidate.
        result=db("BEGIN; SET LOCAL ROLE commonswarm_admin_release; SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false WHERE singleton; UPDATE commonswarm_oauth.admin_cutover_state SET invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton RETURNING release_generation; COMMIT;").splitlines()
        assert len(result)==2 and result[0] in ('t','f') and result[1].isdigit()
        intent.write_text(json.dumps({'reopen':result[0]=='t','generation':int(result[1])})+'\n')
    else:
        reason='recycle-intent-invalid'
        state=json.loads(intent.read_text()); assert isinstance(state['generation'],int) and type(state['reopen']) is bool
        reason='edge-measurement-failed'
        live=pathlib.Path('/home/commonswarm/edge/current').resolve(strict=True); assert str(live)==target
        for attempt in range(46):
            c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
            if c['State'].get('Health',{}).get('Status')=='healthy': break
            if attempt==45: raise ValueError('health timeout')
            time.sleep(2)
        assert c['Image']==r['image_digest'] and c['State']['Health']['Status']=='healthy'
        assert c['Config']['Labels']['com.docker.compose.project.working_dir']==target+'/deploy/edge-runtime'
        assert c['HostConfig']['NetworkMode']=='commonswarm-net' and c['HostConfig']['Memory']==2147483648
        for dst,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
            mounts=[m for m in c['Mounts'] if m['Destination']==dst]
            assert len(mounts)==1 and mounts[0]['Source']==target+'/'+rel and mounts[0]['RW'] is False
        assert hashlib.sha256(archive.read_bytes()).hexdigest()==r['artifact_digest']
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                dest=live/member.name
                assert not pathlib.PurePosixPath(member.name).is_absolute() and '..' not in pathlib.PurePosixPath(member.name).parts
                if member.isfile(): assert not dest.is_symlink() and dest.read_bytes()==tar.extractfile(member).read()
                elif member.issym(): assert dest.is_symlink() and dest.readlink().as_posix()==member.linkname
        measured=sha; reason='database-measurement-refused'
        gen=str(state['generation']); enabled='true' if state['reopen'] else 'false'
        # M4 grants migration_checksum_failures() to the runtime and command roles only, never to the release
        # role: the gate runs as the session's admin user, then the same transaction takes the release role.
        sql="BEGIN; DO $$ BEGIN IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksum_failures()) OR NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND legacy_closed AND auth_contract_version=2 AND approved_edge_release_sha='"+sha+"' AND release_generation="+gen+" AND NOT admin_issuance_enabled AND invalidated_at IS NOT NULL) THEN RAISE EXCEPTION 'recycle measurement refused'; END IF; END $$; SET LOCAL ROLE commonswarm_admin_release; "
        sql+="UPDATE commonswarm_oauth.admin_cutover_state SET measured_edge_release_sha='"+sha+"',measured_edge_target='"+target+"',measured_mount='"+target+"',measured_image_digest='"+r['image_digest']+"',measured_artifact_digest='"+r['artifact_digest']+"',measured_generation=release_generation,measured_at=statement_timestamp(),measurement_evidence_ref='systemd/recycle/"+gen+"',invalidated_at=NULL,admin_issuance_enabled="+enabled+" WHERE singleton; COMMIT;"
        if state['reopen']: assert db('SELECT lane8_evidence_digest IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')=='t'
        # From here the reopen may COMMIT even if this process sees a failure (lost response, psql exit).
        reopen_attempted=bool(state['reopen'])
        db(sql)
except Exception:
    if mode=='close':
        if close_confirmed: raise SystemExit('FAIL recycle hook close: bookkeeping failed after a close CONFIRMED by readback; issuance closed; HezLead must check recycle-intent.json') from None
        closed_marker('admin-issuance-state-unknown')
        raise SystemExit('FAIL recycle hook close; issuance state UNKNOWN (may be OPEN); run ai-emergency-close; HezLead recovery required') from None
    if mode=='after' and reopen_attempted:
        # The reopen may have committed: close it again, and claim CLOSED only after the readback confirms it.
        was,close_confirmed=failure_close()
        if close_confirmed:
            closed_marker()
            raise SystemExit('FAIL recycle hook; reopen not confirmed; issuance closed again (confirmed by readback); HezLead recovery required') from None
        closed_marker('admin-issuance-state-unknown')
        raise SystemExit('FAIL recycle hook; issuance state UNKNOWN (may be OPEN); run ai-emergency-close; HezLead recovery required') from None
    if mode=='before':
        # The close may not have committed: never claim CLOSED here.
        closed_marker('admin-issuance-state-unknown')
        raise SystemExit('FAIL recycle hook before; issuance state UNKNOWN (close not confirmed; may be OPEN); run ai-emergency-close; HezLead recovery required') from None
    # No reopen was attempted, but CLOSED is still claimed only after an independent readback; a failure before the
    # database session exists (no readback possible) is UNKNOWN. Nonrecursive: one readback, no close, no hook run.
    if 'confirm_closed' in globals() and confirm_closed():
        closed_marker()
        raise SystemExit('FAIL recycle hook; issuance CLOSED (confirmed by readback); HezLead recovery required') from None
    closed_marker('admin-issuance-state-unknown')
    raise SystemExit('FAIL recycle hook; issuance state UNKNOWN (no confirming readback; may be OPEN); run ai-emergency-close; HezLead recovery required') from None
PY
```

```sh
# step: ai-recycle-install
# readonly: no
# host: HezLead ONLY, box root, W4 with timer stopped
set -euo pipefail
test "$WINDOW" = W4
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" && exit 1
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive
RECYCLE_DROPIN=/etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
test ! -e "$RECYCLE_DROPIN" || { printf 'FAIL ai-recycle-install: recycle drop-in expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$RECYCLE_DROPIN" || { printf 'FAIL ai-recycle-install: recycle drop-in expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir -p /etc/commonswarm-admin-release /usr/local/libexec "$(dirname "$RECYCLE_DROPIN")"
chmod 0700 /etc/commonswarm-admin-release
python3 - "$PLAN_FILE" /usr/local/libexec/commonswarm-admin-edge-recycle "$INPUTS_FILE" "$RELEASE_ROOT" <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
plan=verified_plan(sys.argv[1],sys.argv[3],'ai-recycle-install').decode(); blocks=re.findall(r'^```sh\n(.*?)^```$',plan,re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-recycle-hook\n')]; assert len(found)==1
hook=('#!/bin/bash\n'+found[0]).encode(); target=sys.argv[2]
if subprocess.run(['/bin/bash','-n'],input=hook).returncode!=0: raise SystemExit('FAIL ai-recycle-install: hook syntax expected valid got invalid; STOP')
try: fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o700)
except OSError: raise SystemExit('FAIL ai-recycle-install: installed hook expected writable-regular-file got symlink-or-unwritable; STOP') from None
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise SystemExit('FAIL ai-recycle-install: installed hook expected regular-file got other; STOP')
    os.fchown(fd,0,0); os.fchmod(fd,0o700); os.write(fd,hook)
finally: os.close(fd)
installed=read_regular(target)
if installed is None or installed!=hook: raise SystemExit('FAIL ai-recycle-install: installed hook expected verified-bytes got changed; STOP')
d=json.load(open(sys.argv[3])); r={'release_sha':d['release_sha'],'target':'/home/commonswarm/edge/releases/'+d['release_sha'],'image_digest':d['baseline_edge_image'],'artifact_digest':d['archive_sha256'],'archive':'/tmp/admin-issuance-'+d['release_sha']+'-'+d['window_id']+'.tar','postgres_image':d['baseline_postgres_image'],'release_root':sys.argv[4]}
p=pathlib.Path('/etc/commonswarm-admin-release/recycle.json'); p.write_text(json.dumps(r)+'\n'); p.chmod(0o600)
PY
printf '[Service]\nEnvironment=COMMONSWARM_RECYCLE_UNIT=%%n\nExecStartPre=/usr/local/libexec/commonswarm-admin-edge-recycle before\nExecStartPost=/usr/local/libexec/commonswarm-admin-edge-recycle after\n' >"$RECYCLE_DROPIN"
chmod 0644 "$RECYCLE_DROPIN"
systemctl daemon-reload
systemctl cat "$EDGE_RECYCLE_SERVICE" >"$PROOF_DIR/recycle-unit-after.txt"
printf 'PASS recycle pre-invalidation/post-measurement hooks installed; no restart performed\n'
```

```sh
# step: ai-recycle-rollback
# readonly: no
# host: HezLead ONLY, box root; called inside guarded W4 rollback
set -euo pipefail
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_TIMER")" = inactive
RECYCLE_DROPIN=/etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
test ! -L "$RECYCLE_DROPIN"
if test -e "$RECYCLE_DROPIN"; then
 rm -- "$RECYCLE_DROPIN" || { printf 'FAIL guarded drop-in removal refused %s; STOP\n' "$RECYCLE_DROPIN" >&2; exit 1; }
fi
systemctl daemon-reload
test ! -e "$RECYCLE_DROPIN"
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t || { printf 'FAIL ai-recycle-rollback: issuance expected closed-by-readback got other-or-unreadable; state UNKNOWN; STOP\n' >&2; exit 2; }
printf 'PASS recycle drop-in removed; issuance closed (readback); caller EXIT guard restores/verifies timer\n'
```

## W5: /app site release

Use the generalized site plan from the **same RELEASE_SHA**, without weakening
its source, main-ancestry, baseline, deletion, retention pin, GO, public byte,
human recovery, secret, rollback and manifest gates. Its exact named inputs are
additional W5 inputs, not fabricated values. EXPECTED_SITE_SHA must equal this
window's measured baseline_site_sha. No borrowing a historical ON receipt.
The approved site plan includes headless view-only QA; before execution HezLead
must explicitly assign that QA to a worker. Our task authorizes no browser
launch. W6 consent authorization is not W5 browser authorization.

```sh
# step: ai-w5-preflight
# readonly: no
# host: Mac /bin/bash 3.2; writes only nonsecret live-controls staging under PREP_DIR
set -euo pipefail
: "${SITE_RELEASE_SHA:?}" "${EXPECTED_SITE_SHA:?}" "${SITE_QA_AUTHORIZATION_FILE:?}"
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
test "$SITE_RELEASE_SHA" = "$RELEASE_SHA" || { printf 'FAIL ai-w5-preflight: SITE_RELEASE_SHA expected input-release-sha got mismatch; STOP\n' >&2; exit 1; }
test "$EXPECTED_SITE_SHA" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_site_sha"])' "$INPUTS_FILE")"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
# Same-build site-build-qa receipt includes the strengthened ownership helper/close.
# The companion site plan uses EXPECTED_SITE_SHA and its existing manifest close.
python3 - "$SITE_QA_AUTHORIZATION_FILE" "$RELEASE_SHA" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
r=json.loads(p.read_text())
assert set(r)=={'approver','release_sha','task_ref','browser'} and r['approver'] in ('Tom','HezLead') and r['release_sha']==sys.argv[2]
try:
    assert r['browser']=='headless-bundled-chromium' and isinstance(r['task_ref'],str) and r['task_ref']
except AssertionError:
    raise SystemExit('FAIL ai-w5-preflight: browser/task_ref expected headless-bundled-chromium/nonempty-string got '+('headless-bundled-chromium' if r['browser']=='headless-bundled-chromium' else 'other-browser')+'/'+('nonempty-string' if isinstance(r['task_ref'],str) and r['task_ref'] else 'invalid-task-ref')+'; STOP') from None
PY
# W5 opening: the complete ai-live-controls block, phase before, bound to the
# pre-W1 consent receipt, before any site build, upload or other side effect.
# Producer bytes come from the prepared release archive, re-verified there.
: "${LIVE_CONTROLS_FILE:?FAIL ai-w5-preflight: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP}"
: "${CONSENT_RECEIPT_FILE:?FAIL ai-w5-preflight: CONSENT_RECEIPT_FILE expected absolute-regular-file got unset; STOP}"
: "${PLAN_FILE:?FAIL ai-w5-preflight: PLAN_FILE expected absolute-regular-file got unset; STOP}"
: "${PREP_DIR:?FAIL ai-w5-preflight: PREP_DIR expected prep-directory got unset; STOP}"
W5_WINDOW=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window"])' "$INPUTS_FILE")
test "$W5_WINDOW" = W5 || { printf 'FAIL ai-w5-preflight: INPUTS window expected W5 got other; STOP\n' >&2; exit 1; }
W5_BEFORE=$PREP_DIR/w5-live-before
test ! -e "$W5_BEFORE" || { printf 'FAIL ai-w5-preflight: live-controls staging expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$W5_BEFORE" || { printf 'FAIL ai-w5-preflight: live-controls staging expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir "$W5_BEFORE"
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$PREP_DIR/release.tar" "$W5_BEFORE" "$LIVE_CONTROLS_FILE" "$CONSENT_RECEIPT_FILE" before yes ai-w5-preflight <<'PY' || { printf 'FAIL ai-w5-preflight: W5 opening live controls expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
```

```sh
# step: ai-w5-reference
# readonly: no
# host: Mac /bin/bash 3.2; invokes one complete reviewed generalized site block
set -euo pipefail
: "${SITE_STEP:?}" "${SITE_RELEASE_REPO:?}" "${PREP_DIR:?}"
if test "$SITE_STEP" = site2-01; then
 export EDGE_RECEIPT_REMOTE=1
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$EDGE_MEASUREMENT_FILE" ai-w5-reference <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^```sh\n(.*?)^```$',verified_plan(sys.argv[1],sys.argv[2],sys.argv[4]).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-edge-receipt\n')]; assert len(found)==1
# argv[3] is the shell's EDGE_MEASUREMENT_FILE; an unexported variable still reaches Python.
subprocess.run(['/bin/bash'],input=found[0],text=True,check=True,env=dict(os.environ,PLAN_FILE=sys.argv[1],INPUTS_FILE=sys.argv[2],EDGE_MEASUREMENT_FILE=sys.argv[3]))
PY
 unset EDGE_RECEIPT_REMOTE
fi
case "$SITE_STEP" in
 site-release-shared-preflight|site2-plan-inputs|site2-00-source-checkout|site2-01|site2-00-a-close-ingest|site2-00-build-env|site2-02|site2-03-browser-session-preflight|site2-03|site2-03-pin-previous|site2-03-go-record|site2-04|site2-04-reconcile-failure|site2-05|site2-05-browser-acceptance|site2-06|site2-07-pre-pin-manifest-close|site2-07-manifest-close) ;;
 *) echo 'FAIL W5 unknown site step; STOP' >&2; exit 1;;
esac
SITE_PLAN=$SITE_RELEASE_REPO/docs/evidence/2026-10-02-site-release/SITE-RELEASE.md
# SITE-RELEASE.md comes from the verified release archive (SITE_RELEASE_SHA equals
# RELEASE_SHA, checked in ai-w5-preflight), read once by fd and re-hashed; after the
# source checkout the repository copy must equal those bytes. The selected block
# reaches the shell only through this substitution: no staged path is reread.
W5_SITE_SOURCE=$(python3 -c '
import hashlib,io,json,os,re,stat,sys,tarfile
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b"".join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def fail(what,expected,got): raise SystemExit("FAIL ai-w5-reference: "+what+" expected "+expected+" got "+got+"; STOP")
archive_path,inputs,step,repo_plan=sys.argv[1:5]
d=json.load(open(inputs))
archive=read_regular(archive_path) if os.path.isabs(archive_path) else None
if archive is None: fail("PREP_DIR/release.tar","absolute-regular-file","missing-or-not-regular")
if hashlib.sha256(archive).hexdigest()!=d.get("archive_sha256"): fail("PREP_DIR/release.tar bytes","input-archive_sha256","mismatch")
try:
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        m=tar.getmember("docs/evidence/2026-10-02-site-release/SITE-RELEASE.md")
        site=tar.extractfile(m).read() if m.isfile() else None
except (KeyError,OSError,tarfile.TarError): site=None
if site is None: fail("SITE-RELEASE.md in release archive","regular-file","missing")
if step not in ("site-release-shared-preflight","site2-plan-inputs","site2-00-source-checkout"):
    if read_regular(repo_plan)!=site: fail("SITE_RELEASE_REPO SITE-RELEASE.md","archive-bytes","different-or-unreadable")
blocks=re.findall(r"^`{3}sh\n(.*?)^`{3}$",site.decode(),re.M|re.S)
found=[b for b in blocks if re.match(r"^# step: "+re.escape(step)+r"(?: —[^\n]*)?\n",b)]
if len(found)!=1: fail("site block "+step,"one","missing-or-duplicate")
sys.stdout.write(found[0])
' "$PREP_DIR/release.tar" "$INPUTS_FILE" "$SITE_STEP" "$SITE_PLAN")
printf '%s\n' "$W5_SITE_SOURCE" | /bin/bash -n
# Evaluate in this shell, NOT a subshell: this plan's site blocks retain state in one Mac shell.
eval "$W5_SITE_SOURCE"
```

Run the referenced plan's exact normal order from its Run order table, including
its error reconciliation and close blocks. Do not shortcut to deploy.sh. W5
requires `admin-site-lifecycle`/projection receipts plus the actual browser QA
receipt and outside GET/HEAD gate closed/CORS probes. Site's automatic rollback
is its explicit preselected failure path; it never retries deployment. Its
protected build env recovery uses the service-account token file. Any rm refusal
STOPs cleanup, with the exact path/message retained. The caller does not execute
the next W window until that referenced site's window is verified closed.
W5 checks the non-consent legs before and after, like every other window.
ai-w5-preflight refuses inputs for any window but W5, then runs the complete
ai-live-controls block with phase before and the pre-W1 CONSENT_RECEIPT_FILE
before any site build, upload or other side effect, and stages the result under
`PREP_DIR/w5-live-before`. ai-w5-closed is W5's forward close: it re-validates
those opening receipts, runs the complete ai-live-controls block with phase
after and the post-W5 CONSENT_RECEIPT_FILE before any outside probe, and retains
ordinary-before.json, consent-pre-W1.json, ordinary-after.json and
consent-post-W5.json beside W5-closed.json. Both read the producer from
`$PREP_DIR/release.tar` (the ai-prepare archive), re-verified against
archive_sha256.

```sh
# step: ai-w5-closed
# readonly: probe
# host: HezLead Mac; after referenced site manifest and browser ownership close
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${SITE_EVIDENCE:?}" "${INPUTS_FILE:?}"
: "${LIVE_CONTROLS_FILE:?FAIL ai-w5-closed: LIVE_CONTROLS_FILE expected absolute-regular-file got unset; STOP}"
: "${CONSENT_RECEIPT_FILE:?FAIL ai-w5-closed: CONSENT_RECEIPT_FILE expected absolute-regular-file got unset; STOP}"
: "${PLAN_FILE:?FAIL ai-w5-closed: PLAN_FILE expected absolute-regular-file got unset; STOP}"
: "${PREP_DIR:?FAIL ai-w5-closed: PREP_DIR expected prep-directory got unset; STOP}"
# W5 forward close: re-validate the retained opening pair, then the complete
# ai-live-controls block, phase after, bound to the post-W5 consent receipt.
# Producer bytes come from the prepared release archive, re-verified there.
W5_WINDOW=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window"])' "$INPUTS_FILE")
test "$W5_WINDOW" = W5 || { printf 'FAIL ai-w5-closed: INPUTS window expected W5 got other; STOP\n' >&2; exit 1; }
W5_BEFORE=$PREP_DIR/w5-live-before
test -f "$W5_BEFORE/ordinary-before.json" || { printf 'FAIL ai-w5-closed: W5 opening receipt expected ordinary-before.json got missing; STOP\n' >&2; exit 1; }
test -f "$W5_BEFORE/consent-pre-W1.json" || { printf 'FAIL ai-w5-closed: W5 opening receipt expected consent-pre-W1.json got missing; STOP\n' >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$PREP_DIR/release.tar" "$W5_BEFORE" "$W5_BEFORE/ordinary-before.json" "$W5_BEFORE/consent-pre-W1.json" before no ai-w5-closed <<'PY' || { printf 'FAIL ai-w5-closed: retained W5 opening receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
W5_LIVE=$PREP_DIR/w5-live-controls
test ! -e "$W5_LIVE" || { printf 'FAIL ai-w5-closed: live-controls staging expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$W5_LIVE" || { printf 'FAIL ai-w5-closed: live-controls staging expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir "$W5_LIVE"
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$PREP_DIR/release.tar" "$W5_LIVE" "$LIVE_CONTROLS_FILE" "$CONSENT_RECEIPT_FILE" after yes ai-w5-closed <<'PY' || { printf 'FAIL ai-w5-closed: W5 forward-close live controls expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
python3 - "$INPUTS_FILE" "$SITE_EVIDENCE" "$W5_LIVE" "$W5_BEFORE" <<'PY'
import datetime,hashlib,json,pathlib,subprocess,urllib.request,sys
d=json.load(open(sys.argv[1])); site=pathlib.Path(sys.argv[2])
assert d['window']=='W5' and site.is_absolute() and site.is_dir() and not site.is_symlink()
close=site/'CLOSE.txt'; assert close.is_file() and not close.is_symlink()
lines=close.read_text().splitlines()
assert 'CLOSED=yes' in lines and 'OUTCOME=released' in lines and 'PIN_RELEASED=yes' in lines, 'FAIL site ownership/manifest close not released; STOP'
manifest=site/'manifest.json'; digest=hashlib.sha256(manifest.read_bytes()).hexdigest()
assert lines.count('MANIFEST_SHA256='+digest)==1, 'FAIL site close manifest digest; STOP'
for row in json.loads(manifest.read_text()):
    rel=pathlib.PurePosixPath(row['path']); assert not rel.is_absolute() and '..' not in rel.parts
    path=site/rel; assert path.is_file() and not path.is_symlink()
    assert hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256']
# Ownership stop/guarded secret cleanup precede CLOSE.txt in the reviewed site plan.
# Exact site source/main ancestry and strengthened close are checker-gated before release.
for method in ('GET','HEAD'):
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with urllib.request.urlopen(req,timeout=15) as response:
        body=response.read(4097)
        try:
            assert response.status==200 and response.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in response.headers.get('Cache-Control','')
        except AssertionError:
            raise SystemExit(f'FAIL ai-w5-closed: {method} /admin/gate status/ACAO/cache expected 200/*/no-store got {response.status}/'+('*' if response.headers.get('Access-Control-Allow-Origin')=='*' else 'non-wildcard-or-missing')+'/'+('no-store' if 'no-store' in response.headers.get('Cache-Control','') else 'missing-no-store')+'; STOP') from None
        try:
            assert (json.loads(body)=={'state':'closed'}) if method=='GET' else body==b''
        except json.JSONDecodeError:
            raise SystemExit(f'FAIL ai-w5-closed: {method} /admin/gate body expected closed-JSON got non-JSON; STOP') from None
        except AssertionError:
            raise SystemExit(f'FAIL ai-w5-closed: {method} /admin/gate body expected '+('closed' if method=='GET' else 'empty')+' got '+(('open' if json.loads(body)=={'state':'open'} else 'non-closed') if method=='GET' else 'nonempty')+'; STOP') from None
client='https://commonswarm.com/oauth/c1-smoke/client.json'
req=urllib.request.Request(client,headers={'User-Agent':'curl/8.7.1'})
with urllib.request.urlopen(req,timeout=15) as response:
    assert response.status==200 and response.headers.get('Content-Type','').split(';')[0]=='application/json'
    document=json.loads(response.read(4097))
canonical=json.loads(subprocess.check_output(['node','scripts/admin-smoke.mjs','--print-client-metadata'],text=True))
assert document==canonical, 'FAIL public canonical CIMD client; STOP'
with urllib.request.urlopen(urllib.request.Request(canonical['redirect_uris'][0],headers={'User-Agent':'curl/8.7.1'}),timeout=15) as response:
    assert response.status==200 and response.headers.get('Content-Type','').split(';')[0]=='text/html', 'FAIL public callback page; STOP'
root=pathlib.Path('/Users/yulanbot/work/hm37-live-release')/(d['release_sha']+'-W5-'+d['window_id'])
root.mkdir(mode=0o700,parents=True,exist_ok=False)
(root/'inputs.json').write_text(json.dumps(d)+'\n')
(root/'W5-closed.json').write_text(json.dumps({'state':'closed','site_ownership_close':'PASS'})+'\n')
for name in ('ordinary-after.json','consent-post-W5.json'): (root/name).write_bytes(pathlib.Path(sys.argv[3],name).read_bytes())
for name in ('ordinary-before.json','consent-pre-W1.json'): (root/name).write_bytes(pathlib.Path(sys.argv[4],name).read_bytes())
(root/'closed.txt').write_text(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')+'\n')
print('PASS W5 site ownership close and outside GET/HEAD gate CLOSED; retain W5 closed.txt for W6')
PY
```

W5 companion recovery conditions (verbatim from SITE-RELEASE.md Failure paths):

| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` verifies baseline unchanged and closes without a pin. |
| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |
| `site2-05` or blocking `site2-05-browser-acceptance` fails | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |

W5 C1 recovered close runs only after site2-07-manifest-close has recorded
CLOSED=yes with OUTCOME=rolled-back or OUTCOME=failed-before-switch, released
the pin, and completed cleanup; GO and partial-pin failures stay open.

For W5 recovery, run the companion reconciliation/rollback verification and
its applicable manifest close first. Partial-pin, GO and cleanup failures
remain open incidents; do not dispatch a C1 close. ai-w5-recovery-transfer
copies only the companion's closed, manifest-bound nonsecret receipts to the
box. A second transfer with the same inputs/window/PREP_DIR resumes after
validating retained archive bytes, proof-directory identity/owner/mode and
non-symlink /tmp upload paths; it never overwrites immutable reviewed archives.
In a fresh persistent box root shell run ai-w5-recovery-env (never ai-open or
ai-db-session) before ai-close: it derives WINDOW, PROOF_DIR, INPUTS_FILE,
BOX_ARCHIVE_PATH, SITE_RECOVERY_EVIDENCE, PLAN_FILE and CLOSE_RESULT=recovered
from the transferred inputs and refuses any mismatch.
ai-close recovered verifies the rollback or failed-before-switch reconciliation
and current equal to the measured baseline_site_sha release, then records
CLOSED-RECOVERED. ai-w5-closed still accepts OUTCOME=released only.

```sh
# step: ai-w5-recovery-transfer
# readonly: no
# host: HezLead Mac; only after the companion plan completed its recovery and cleanup
set -euo pipefail
: "${INPUTS_FILE:?}" "${SITE_EVIDENCE:?}" "${PREP_DIR:?}"
python3 - "$SITE_EVIDENCE" "$PREP_DIR/site-recovery.tar" "$INPUTS_FILE" <<'PY'
import hashlib,json,os,pathlib,stat,tarfile,sys
root=pathlib.Path(sys.argv[1]); archive=pathlib.Path(sys.argv[2]); inputs=pathlib.Path(sys.argv[3])
def refuse(what): raise SystemExit('FAIL ai-w5-recovery-transfer: '+what+'; STOP')
if not (root.is_absolute() and root.is_dir() and not root.is_symlink()): refuse('SITE_EVIDENCE expected absolute-directory got other')
if not (inputs.is_absolute() and inputs.is_file() and not inputs.is_symlink()): refuse('INPUTS_FILE expected absolute-regular-file got other')
close=root/'CLOSE.txt'; manifest=root/'manifest.json'
if not all(p.is_file() and not p.is_symlink() for p in (close,manifest)): refuse('CLOSE.txt/manifest.json expected regular-files got other')
rows=close.read_text().splitlines()
if 'CLOSED=yes' not in rows or 'PIN_RELEASED=yes' not in rows: refuse('CLOSE.txt expected CLOSED-and-pin-released got other')
if len([x for x in rows if x.startswith('OUTCOME=')])!=1 or not any('OUTCOME='+v in rows for v in ('rolled-back','failed-before-switch')): refuse('CLOSE.txt OUTCOME expected rolled-back-or-failed-before-switch got other')
if rows.count('MANIFEST_SHA256='+hashlib.sha256(manifest.read_bytes()).hexdigest())!=1: refuse('CLOSE.txt MANIFEST_SHA256 expected manifest digest got other')
payload={'CLOSE.txt':close.read_bytes(),'manifest.json':manifest.read_bytes()}
names=['CLOSE.txt','manifest.json']
for r in json.loads(manifest.read_text()):
    rel=pathlib.PurePosixPath(r['path']);
    if rel.is_absolute() or '..' in rel.parts: refuse('manifest path expected relative-without-dotdot got other')
    path=root/rel
    if not (path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root.resolve())): refuse(str(rel)+' expected regular-file under evidence got other')
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=r['sha256']: refuse(str(rel)+' digest expected manifest sha256 got other')
    payload[str(rel)]=data; names.append(str(rel))
if archive.exists() or archive.is_symlink():
    if archive.is_symlink() or not archive.is_file(): refuse('site-recovery.tar expected regular-non-symlink for resume got other')
    mode=stat.S_IMODE(archive.stat().st_mode)
    if mode not in (0o600,0o644): refuse('site-recovery.tar mode expected 0600-or-0644 got other')
    try:
        with tarfile.open(archive,'r') as tar:
            members=set(tar.getnames())
            if members!=set(names): refuse('retained site-recovery.tar members expected current-evidence got other')
            for name in names:
                member=tar.getmember(name)
                if not member.isfile(): refuse(name+' in retained tar expected regular-file got other')
                if tar.extractfile(member).read()!=payload[name]: refuse(name+' in retained tar expected evidence bytes got other')
    except tarfile.TarError: refuse('retained site-recovery.tar expected readable-archive got other')
else:
    with tarfile.open(archive,'x') as tar:
        for name in names: tar.add(root/name,arcname=name,recursive=False)
    os.chmod(archive,0o600)
PY
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
SITE_RECOVERY_DEST=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-W5-${WINDOW_ID}/site-recovery
SITE_C1_PROOF=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-W5-${WINDOW_ID}
: "${LIVE_CONTROLS_FILE:?}" "${CONSENT_RECEIPT_FILE:?}"
for SITE_C1_FILE in "$INPUTS_FILE" "$LIVE_CONTROLS_FILE" "$CONSENT_RECEIPT_FILE" "$PREP_DIR/release.tar"; do
 test -f "$SITE_C1_FILE" && test ! -L "$SITE_C1_FILE"
done
printf -v SITE_RECOVERY_REMOTE 'sudo -n /bin/bash -s -- %q' "$SITE_C1_PROOF"
ssh -o BatchMode=yes ops@100.115.66.74 "$SITE_RECOVERY_REMOTE" <<'BOX'
set -euo pipefail
proof=$1
case "$proof" in /home/commonswarm/admin-issuance/release-proofs/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-W5-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) printf 'FAIL ai-w5-recovery-transfer: proof directory expected this-window W5 path got other; STOP\n' >&2; exit 1;; esac
if test -L "$proof"; then printf 'FAIL ai-w5-recovery-transfer: proof directory expected not-symlink got symlink; STOP\n' >&2; exit 1; fi
if test -e "$proof"; then
 test -d "$proof" || { printf 'FAIL ai-w5-recovery-transfer: proof directory expected directory got other; STOP\n' >&2; exit 1; }
 test "$(stat -c '%a %u %g' "$proof")" = '700 0 0' || { printf 'FAIL ai-w5-recovery-transfer: proof directory expected 0700-root-root got other; STOP\n' >&2; exit 1; }
else
 mkdir -m 0700 "$proof"
 chown root:root "$proof"
fi
BOX
SITE_C1_UPLOAD=$(ssh -o BatchMode=yes ops@100.115.66.74 'umask 077; mktemp -d /tmp/admin-site-c1.XXXXXX') || { printf 'FAIL ai-w5-recovery-transfer: upload stage expected mktemp got failure; STOP\n' >&2; exit 1; }
case "$SITE_C1_UPLOAD" in /tmp/admin-site-c1.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) printf 'FAIL ai-w5-recovery-transfer: upload directory expected /tmp/admin-site-c1.XXXXXX got other; STOP\n' >&2; exit 1;; esac
scp "$INPUTS_FILE" "ops@100.115.66.74:$SITE_C1_UPLOAD/inputs.json"
scp "$LIVE_CONTROLS_FILE" "ops@100.115.66.74:$SITE_C1_UPLOAD/ordinary-recovery.json"
scp "$CONSENT_RECEIPT_FILE" "ops@100.115.66.74:$SITE_C1_UPLOAD/consent-post-W5.json"
scp "$PREP_DIR/release.tar" "ops@100.115.66.74:$SITE_C1_UPLOAD/release.tar"
printf -v SITE_RECOVERY_REMOTE 'sudo -n /bin/bash -s -- %q %q' "$SITE_C1_UPLOAD" "$SITE_C1_PROOF"
ssh -o BatchMode=yes ops@100.115.66.74 "$SITE_RECOVERY_REMOTE" <<'BOX'
set -euo pipefail
# Compare every retained dest with the incoming bytes BEFORE writing anything.
for file in inputs.json ordinary-recovery.json consent-post-W5.json release.tar; do
 test -f "$1/$file" && test ! -L "$1/$file" || { printf 'FAIL ai-w5-recovery-transfer: upload %s expected regular-non-symlink got other; STOP\n' "$file" >&2; exit 1; }
 if test -L "$2/$file"; then printf 'FAIL ai-w5-recovery-transfer: retained %s expected not-symlink got symlink; STOP\n' "$file" >&2; exit 1; fi
 if test -e "$2/$file"; then
  test -f "$2/$file" || { printf 'FAIL ai-w5-recovery-transfer: retained %s expected regular-file got other; STOP\n' "$file" >&2; exit 1; }
  cmp -s "$1/$file" "$2/$file" || { printf 'FAIL ai-w5-recovery-transfer: retained %s expected byte-identical-to-upload got mismatch; STOP\n' "$file" >&2; exit 1; }
 fi
done
for file in inputs.json ordinary-recovery.json consent-post-W5.json release.tar; do
 if test ! -e "$2/$file"; then
  install -o root -g root -m 0600 "$1/$file" "$2/$file"
 fi
done
BOX
SITE_RECOVERY_DIGEST=$(shasum -a 256 "$PREP_DIR/site-recovery.tar" | awk '{print $1}')
SITE_RECOVERY_STAGE=$(ssh -o BatchMode=yes ops@100.115.66.74 'umask 077; mktemp -d /tmp/admin-site-recovery.XXXXXX') || { printf 'FAIL ai-w5-recovery-transfer: recovery tar stage expected mktemp got failure; STOP\n' >&2; exit 1; }
case "$SITE_RECOVERY_STAGE" in /tmp/admin-site-recovery.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) printf 'FAIL ai-w5-recovery-transfer: recovery tar stage expected /tmp/admin-site-recovery.XXXXXX got other; STOP\n' >&2; exit 1;; esac
SITE_RECOVERY_UPLOAD=$SITE_RECOVERY_STAGE/site-recovery.tar
scp "$PREP_DIR/site-recovery.tar" "ops@100.115.66.74:$SITE_RECOVERY_UPLOAD"
printf -v SITE_RECOVERY_REMOTE 'sudo -n /bin/bash -s -- %q %q %q' "$SITE_RECOVERY_UPLOAD" "$SITE_RECOVERY_DEST" "$SITE_RECOVERY_DIGEST"
ssh -o BatchMode=yes ops@100.115.66.74 "$SITE_RECOVERY_REMOTE" <<'BOX'
set -euo pipefail
upload=$1; dest=$2; digest=$3
test -f "$upload" && test ! -L "$upload"
test "$(sha256sum "$upload" | awk '{print $1}')" = "$digest"
if test -L "$dest"; then printf 'FAIL ai-w5-recovery-transfer: site-recovery dest expected not-symlink got symlink; STOP\n' >&2; exit 1; fi
if test -e "$dest"; then
 test -d "$dest" || { printf 'FAIL ai-w5-recovery-transfer: site-recovery dest expected directory got other; STOP\n' >&2; exit 1; }
 test "$(stat -c '%a %u %g' "$dest")" = '700 0 0' || { printf 'FAIL ai-w5-recovery-transfer: site-recovery dest expected 0700-root-root got other; STOP\n' >&2; exit 1; }
 SITE_RECOVERY_EXTRACT=$(python3 - "$upload" "$dest" <<'PY' || { printf 'FAIL ai-w5-recovery-transfer: retained site-recovery tree expected tar-file-list-and-digests got other; STOP\n' >&2; exit 1; }
import hashlib,os,pathlib,sys,tarfile
upload,dest=map(pathlib.Path,sys.argv[1:3])
def refuse(what): raise SystemExit('FAIL ai-w5-recovery-transfer: '+what+'; STOP')
expected={}
with tarfile.open(upload,'r') as tar:
    for m in tar.getmembers():
        rel=pathlib.PurePosixPath(m.name)
        if rel.is_absolute() or '..' in rel.parts: refuse(m.name+' tar member expected relative-without-dotdot got other')
        n=rel.as_posix().rstrip('/')
        if n in ('','.'): continue
        if m.issym(): expected[n]=('symlink',m.linkname)
        elif m.isdir(): expected[n]=('dir',None)
        elif m.isfile(): expected[n]=('file',hashlib.sha256(tar.extractfile(m).read()).hexdigest())
        else: refuse(m.name+' in recovery tar expected file-dir-or-symlink got other')
        parent=str(rel.parent)
        while parent not in ('.','') and parent not in expected:
            expected[parent]=('dir',None); parent=str(pathlib.PurePosixPath(parent).parent)
observed={}
for dirpath, dirnames, filenames in os.walk(dest):
    for name in dirnames+filenames:
        p=pathlib.Path(dirpath)/name
        rel=p.relative_to(dest).as_posix()
        if p.is_symlink(): observed[rel]=('symlink',os.readlink(p))
        elif p.is_dir(): observed[rel]=('dir',None)
        elif p.is_file(): observed[rel]=('file',hashlib.sha256(p.read_bytes()).hexdigest())
        else: refuse(rel+' in retained tree expected file-dir-or-symlink got other')
missing=sorted(set(expected)-set(observed)); extra=sorted(set(observed)-set(expected))
changed=sorted(n for n in expected if n in observed and observed[n]!=expected[n])
if missing or extra or changed:
    refuse('retained site-recovery tree expected tar-file-list-and-digests got differ missing='+','.join(missing)+' extra='+','.join(extra)+' changed='+','.join(changed))
print('identical')
PY
)
 test "$SITE_RECOVERY_EXTRACT" = identical || { printf 'FAIL ai-w5-recovery-transfer: retained site-recovery tree expected identical-to-tar got other; STOP\n' >&2; exit 1; }
else
 mkdir -m 0700 "$dest"
 tar --no-same-owner -xf "$upload" -C "$dest"
fi
BOX
```

```sh
# step: ai-w5-recovery-env
# readonly: no
# host: HezLead box root; W5 recovered-close persistent shell initialization; never ai-open or ai-db-session
set -euo pipefail
: "${INPUTS_FILE:?FAIL ai-w5-recovery-env: INPUTS_FILE expected transferred-inputs got unset; STOP}"
unset WINDOW WINDOW_ID RELEASE_SHA PROOF_DIR BOX_ARCHIVE_PATH SITE_RECOVERY_EVIDENCE PLAN_FILE CLOSE_RESULT
out=$(python3 - "$INPUTS_FILE" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys,tarfile
def refuse(what): raise SystemExit('FAIL ai-w5-recovery-env: '+what+'; STOP')
src=pathlib.Path(sys.argv[1])
if not (src.is_absolute() and src.is_file() and not src.is_symlink()): refuse('INPUTS_FILE expected absolute-regular-file got other')
try: d=json.loads(src.read_text())
except ValueError: refuse('INPUTS_FILE expected JSON object got other')
sha,wid=d.get('release_sha'),d.get('window_id')
if d.get('window')!='W5' or not isinstance(sha,str) or re.fullmatch('[0-9a-f]{40}',sha) is None or not isinstance(wid,str) or re.fullmatch('[A-Za-z0-9]{6}',wid) is None:
    refuse('inputs window/release_sha/window_id expected W5-full-sha-six-id got other')
proof=pathlib.Path('/home/commonswarm/admin-issuance/release-proofs/'+sha+'-W5-'+wid)
if proof.is_symlink() or not proof.is_dir(): refuse('PROOF_DIR expected transfer directory got missing-or-symlink')
info=proof.stat()
if stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid not in (0, os.geteuid()): refuse('PROOF_DIR expected 0700 owner-matched got other')
transferred=proof/'inputs.json'
if not (transferred.is_file() and not transferred.is_symlink()): refuse('transferred inputs.json expected regular-file got other')
if hashlib.sha256(transferred.read_bytes()).hexdigest()!=hashlib.sha256(src.read_bytes()).hexdigest():
    refuse('transferred inputs.json expected identical-to-INPUTS_FILE got mismatch')
archive=proof/'release.tar'
if not (archive.is_file() and not archive.is_symlink()): refuse('BOX_ARCHIVE_PATH expected transferred release.tar got other')
if hashlib.sha256(archive.read_bytes()).hexdigest()!=d.get('archive_sha256'): refuse('release.tar digest expected inputs archive_sha256 got mismatch')
site=proof/'site-recovery'
if site.is_symlink() or not site.is_dir(): refuse('SITE_RECOVERY_EVIDENCE expected transferred site-recovery directory got other')
plan=proof/'RELEASE.md'
member='docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'
try:
    with tarfile.open(archive) as tar:
        m=tar.getmember(member)
        if not m.isfile(): refuse('reviewed plan member expected regular-file got other')
        raw=tar.extractfile(m).read()
except (KeyError,OSError,tarfile.TarError): refuse('reviewed plan expected in transferred archive got missing')
if hashlib.sha256(raw).hexdigest()!=d.get('plan_sha256'): refuse('reviewed plan digest expected inputs plan_sha256 got mismatch')
if plan.exists() or plan.is_symlink():
    if plan.is_symlink() or not plan.is_file() or plan.read_bytes()!=raw: refuse('PROOF_DIR/RELEASE.md expected identical-reviewed-plan got other')
else:
    plan.write_bytes(raw); plan.chmod(0o600)
def sh(name,value):
    print(name+'='+json.dumps(value))
sh('WINDOW','W5'); sh('WINDOW_ID',wid); sh('RELEASE_SHA',sha)
sh('PROOF_DIR',str(proof)); sh('INPUTS_FILE',str(transferred))
sh('BOX_ARCHIVE_PATH',str(archive)); sh('SITE_RECOVERY_EVIDENCE',str(site))
sh('PLAN_FILE',str(plan)); sh('CLOSE_RESULT','recovered')
print("printf '%s\\n' "+json.dumps('PASS ai-w5-recovery-env: WINDOW PROOF_DIR INPUTS_FILE BOX_ARCHIVE_PATH SITE_RECOVERY_EVIDENCE PLAN_FILE CLOSE_RESULT set from transferred W5 proof'))
PY
) || exit 1
eval "$out"
: "${WINDOW:?}" "${WINDOW_ID:?}" "${RELEASE_SHA:?}" "${PROOF_DIR:?}" "${INPUTS_FILE:?}" "${BOX_ARCHIVE_PATH:?}" "${SITE_RECOVERY_EVIDENCE:?}" "${PLAN_FILE:?}" "${CLOSE_RESULT:?}"
test "$WINDOW" = W5 && test "$CLOSE_RESULT" = recovered
```

## W6 readiness: before any open or activation

Use the canonical BROWSER-READY path on the Mac; the box consumes only the
nonsecret mode-0600 copy made by ai-w6-readiness-transfer. W5 inputs, closed
receipt and close timestamp travel together. Never fabricate a close marker.

```sh
# step: ai-w6-readiness
# readonly: yes
# host: Mac or box; required again immediately before activation
set -euo pipefail
: "${INPUTS_FILE:?}" "${W5_CLOSED_FILE:?}" "${BROWSER_READY_FILE:?}"
python3 - "$INPUTS_FILE" "$W5_CLOSED_FILE" "$BROWSER_READY_FILE" <<'PY'
import datetime,json,pathlib,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
d=json.load(open(sys.argv[1])); close,ready=map(pathlib.Path,sys.argv[2:])
assert all(p.is_absolute() and p.is_file() and not p.is_symlink() for p in (close,ready)), 'FAIL W6 fresh BROWSER-READY required; STOP'
w=json.load(open(close.parent/'inputs.json')); assert w['release_sha']==d['release_sha'] and w['window']=='W5'
assert json.load(open(close.parent/'W5-closed.json'))['state']=='closed'
closed_at=box_utc(close.read_text().strip()); assert closed_at is not None, 'FAIL W5 closed.txt expected aware-UTC-ISO-8601-time got other; STOP'
t=closed_at.timestamp()
assert ready.stat().st_mtime>t and ready.stat().st_mtime<=datetime.datetime.now(datetime.timezone.utc).timestamp(), 'FAIL W6 BROWSER-READY must be newer than W5 close; STOP'
PY
```

```sh
# step: ai-w6-readiness-transfer
# readonly: no
# host: HezLead Mac; nonsecret transport before W6 box open
set -euo pipefail
test "$BROWSER_READY_FILE" = /Users/yulanbot/work/BROWSER-READY
: "${W5_CLOSED_FILE:?}"
C1_READY_DEST=$(ssh -o BatchMode=yes ops@100.115.66.74 'umask 077; mktemp -d /tmp/admin-c1-ready.XXXXXX') || { printf 'FAIL ai-w6-readiness-transfer: ready dest expected mktemp got failure; STOP\n' >&2; exit 1; }
case "$C1_READY_DEST" in /tmp/admin-c1-ready.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) printf 'FAIL ai-w6-readiness-transfer: ready dest expected /tmp/admin-c1-ready.XXXXXX got other; STOP\n' >&2; exit 1;; esac
scp -p "$BROWSER_READY_FILE" "$W5_CLOSED_FILE" "${W5_CLOSED_FILE%/*}/inputs.json" "${W5_CLOSED_FILE%/*}/W5-closed.json" "ops@100.115.66.74:$C1_READY_DEST/"
# Box uses W5_CLOSED_FILE=$C1_READY_DEST/closed.txt and BROWSER_READY_FILE=$C1_READY_DEST/BROWSER-READY.
```

## W6: separate activation approval and executable preconditions

Every gate in GATES.json's W6 set is required against the exact combined build.
This includes every lane-8 gate in Composer/Grok findings, the lane-6a timeout
AbortSignal follow-up and the verified-client registry visibility decision.
The same-build integration `admin-activation-chain` is a preproduction receipt;
W6's production C1 receipt follows activation and is not substituted for it.

```sh
# step: ai-w6-activation-approval
# readonly: yes
# host: Mac or box; execute before any W6 staging, network or mutation
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W6' and isinstance(a,dict), 'FAIL W6 explicit activation approval required; STOP'
assert a.get('action')=='activate-admin-issuance-and-smoke' and a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref'), 'FAIL W6 approval identity; STOP'
assert all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W6 approval binding; STOP'
print('W6 activation and consent approval present; every named proof and measured production prerequisites remain required')
PY
```

```sh
# step: ai-w6-activation-checks
# readonly: no
# host: box root; DB read-only; Mac already ran ai-gates; box binds receipt digest
set -euo pipefail
test "$WINDOW" = W6
ai_run ai-w6-readiness
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$EDGE_MEASUREMENT_FILE" ai-w6-activation-checks <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^```sh\n(.*?)^```$',verified_plan(sys.argv[1],sys.argv[2],sys.argv[4]).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-edge-receipt\n')]; assert len(found)==1
# argv[3] is the shell's EDGE_MEASUREMENT_FILE; an unexported variable still reaches Python.
subprocess.run(['/bin/bash'],input=found[0],text=True,check=True,env=dict(os.environ,PLAN_FILE=sys.argv[1],INPUTS_FILE=sys.argv[2],EDGE_MEASUREMENT_FILE=sys.argv[3]))
PY
ai_run ai-w6-activation-approval
ai_run ai-gates-bind
ai_deadline
# Issuer credential provenance: the W2b named by w2b_release_sha and w2b_window_id (it may be an earlier
# release) closed success and provisioned it; validated by CONTENT through the shared validator (ai-w2b-proof-check).
PROOF_CHECK_KIND=W2b
W2B_BINDING=$(ai_run ai-w2b-proof-check) || { printf 'FAIL ai-w6-activation-checks: issuer credential provenance expected closed-success bound W2b got refused; STOP\n' >&2; exit 1; }
unset PROOF_CHECK_KIND
printf '%s\n' "$W2B_BINDING" >"$PROOF_DIR/issuer-provenance.json"
# The provenance is a record; the credential itself is re-verified live, now.
( ai_run ai-w6-issuer-live ) || { printf 'FAIL ai-w6-activation-checks: issuer credential expected live LOGIN, installed 0440 root:986, TLS login and forward catalogs got refused; STOP\n' >&2; exit 1; }
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(readlink -f /home/commonswarm/oauth/current)" = "/home/commonswarm/oauth/releases/$RELEASE_SHA"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1)")" = "$RELEASE_SHA"
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
ai_ro -Atq --command "SELECT l.version,c.sha256,s.required_migrations->>l.version FROM supabase_migrations.schema_migrations l JOIN commonswarm_ops.migration_checksums c USING(version) CROSS JOIN commonswarm_oauth.admin_cutover_state s WHERE s.singleton AND l.version IN ('20261001000001','20261001000002','20261001000003','20261001000004','20261001000005','20260928000003','20261002000001','20261003000001','20261003000002','20261003000003','20261003000004','20261003000005') ORDER BY l.version;" >"$PROOF_DIR/activation-migrations.txt"
python3 - "$RELEASE_ROOT" "$PROOF_DIR/activation-migrations.txt" "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); d=json.load(open(sys.argv[3])); expected=[]
for v in ['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+['2026100300000'+str(i) for i in range(1,6)]:
    files=list((root/'supabase/migrations').glob(v+'_*.sql')); assert len(files)==1
    h=hashlib.sha256(files[0].read_bytes()).hexdigest(); expected.append('|'.join([v,h,h]))
assert pathlib.Path(sys.argv[2]).read_text().splitlines()==sorted(expected), 'FAIL exact activation ledger/checksums including recovery 05; STOP'
assert d['baseline_site_sha']==d['release_sha'], 'FAIL site source not combined build; STOP'
PY
test "$(ai_ro -Atq --command "SELECT NOT admin_issuance_enabled AND legacy_closed AND legacy_fence_evidence_ref IS NOT NULL AND auth_contract_version=2 AND approved_edge_release_sha='$RELEASE_SHA' AND measured_edge_release_sha='$RELEASE_SHA' AND measured_generation=release_generation AND invalidated_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t
test "$(ai_ro -Atq --command "SELECT NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='swarm.admin_credentials'::regclass);")" = t
# Remeasure the live image/mount/artifact against the independently recorded row.
ai_ro -Atq --command "SELECT measured_edge_target,measured_artifact_digest,measured_image_digest,measured_mount FROM commonswarm_oauth.admin_cutover_state WHERE singleton;" >"$PROOF_DIR/measurement-before-activation.txt"
python3 - "$PROOF_DIR/measurement-before-activation.txt" "$RELEASE_SHA" "$INPUTS_FILE" <<'PY'
import hashlib,json,pathlib,subprocess,sys,tarfile
target='/home/commonswarm/edge/releases/'+sys.argv[2]; d=json.load(open(sys.argv[3]))
parts=pathlib.Path(sys.argv[1]).read_text().strip().split('|'); assert len(parts)==4
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
archive=pathlib.Path('/tmp/admin-issuance-'+sys.argv[2]+'-'+d['window_id']+'.tar')
assert parts==[target,d['archive_sha256'],c['Image'],target]
assert hashlib.sha256(archive.read_bytes()).hexdigest()==parts[1]
assert c['Config']['Labels']['com.docker.compose.project.working_dir']==target+'/deploy/edge-runtime'
for dst,rel in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]:
    m=[m for m in c['Mounts'] if m['Destination']==dst]
    assert len(m)==1 and m[0]['Source']==target+'/'+rel and m[0]['RW'] is False
with tarfile.open(archive) as t:
    for member in t.getmembers():
        if member.isfile(): assert (pathlib.Path(target)/member.name).read_bytes()==t.extractfile(member).read()
PY
# The recycle hook re-verifies W4's retained archive on every run (and W6 runs it): it must exist with its digest now.
python3 - "$RELEASE_SHA" "$INPUTS_FILE" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w6-activation-checks: '+what+' expected '+expected+' got '+got+'; STOP')
p=pathlib.Path('/etc/commonswarm-admin-release/recycle.json')
# Ownership is the hook's own check at every run; here: present, regular, 0600.
need(p.is_file() and not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==0o600,'recycle.json','0600-regular-file','other')
r=json.loads(p.read_text()); d=json.load(open(sys.argv[2]))
need(r.get('release_sha')==sys.argv[1] and r.get('artifact_digest')==d['archive_sha256'],'recycle.json release/artifact','this-release-archive','other')
archive=pathlib.Path(r.get('archive',''))
need(re.fullmatch(r'/tmp/admin-issuance-'+sys.argv[1]+r'-[A-Za-z0-9]{6}\.tar',str(archive)) is not None and archive.is_file() and not archive.is_symlink(),'recycle archive','retained-regular-file','missing')
need(hashlib.sha256(archive.read_bytes()).hexdigest()==r['artifact_digest'],'recycle archive digest','recycle.json artifact_digest','mismatch')
PY
printf 'PASS W6 DB release identity/checksum/legacy controls; activation prerequisites complete\n' >"$PROOF_DIR/W6-checks.txt"
```

The issuer credential is re-verified live at every W6, whichever release its
W2b ran at: the provenance proves who provisioned it, not that it still works.

```sh
# step: ai-w6-issuer-live
# readonly: yes
# host: box root, W6; run through ai_run by ai-w6-activation-checks after the W2b provenance; database read-only
set -euo pipefail
# Every step fails explicitly: the caller runs ( ai_run ai-w6-issuer-live ) || ..., where errexit is ignored.
test "$WINDOW" = W6 || { printf 'FAIL ai-w6-issuer-live: window expected W6 got other; STOP\n' >&2; exit 1; }
test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w6-issuer-live: issuer credential file expected not-symlink got symlink; STOP\n' >&2; exit 1; }
test -f /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-w6-issuer-live: issuer credential file expected regular-file got missing; STOP\n' >&2; exit 1; }
test "$(stat -c '%a %u %g' /etc/commonswarm-oauth/admin-issuer-database-credentials)" = '440 0 986' || { printf 'FAIL ai-w6-issuer-live: issuer credential mode expected 440-0-986 got other; STOP\n' >&2; exit 1; }
W6_ISSUER_ROLE=$(ai_ro -Atq --command "SELECT rolcanlogin AND rolpassword IS NOT NULL FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';") || { printf 'FAIL ai-w6-issuer-live: issuer role query expected success got failure; STOP\n' >&2; exit 1; }
test "$W6_ISSUER_ROLE" = t || { printf 'FAIL ai-w6-issuer-live: issuer role expected LOGIN-with-password got other; STOP\n' >&2; exit 1; }
# Login files from the INSTALLED credential (never printed): ai-db-session's service file with the issuer user, key=value only.
python3 - /etc/commonswarm-oauth/admin-issuer-database-credentials "$SECRET_STAGE" <<'PY' || { printf 'FAIL ai-w6-issuer-live: login files from the installed credential expected prepared got refused; STOP\n' >&2; exit 1; }
import configparser,json,pathlib,re,sys
try:
    cred=json.loads(pathlib.Path(sys.argv[1]).read_text()); p=pathlib.Path(sys.argv[2])
    assert isinstance(cred,dict) and set(cred)=={'user','password'} and cred['user']=='commonswarm_admin_issuer'
    assert isinstance(cred['password'],str) and re.fullmatch('[0-9a-f]{64}',cred['password'])
    c=configparser.ConfigParser(interpolation=None); c.read(p/'service.conf')
    assert c.has_section('target'); c['target']['user']='commonswarm_admin_issuer'
    with (p/'issuer-live-service.conf').open('w') as f: c.write(f,space_around_delimiters=False)
    for line in (p/'issuer-live-service.conf').read_text().splitlines():
        assert not line or re.fullmatch(r'\[[a-z_]+\]',line) or re.fullmatch(r'[a-z_]+=[^ ].*',line)
    rows=(p/'pass').read_text().splitlines(); assert len(rows)==1
    parts=rows[0].split(':'); assert len(parts)==5
    (p/'issuer-live-pass').write_text(':'.join(parts[:3]+['commonswarm_admin_issuer',cred['password']])+'\n')
    for name in ['issuer-live-service.conf','issuer-live-pass']: (p/name).chmod(0o600)
except Exception:
    raise SystemExit(1) from None
PY
docker run --rm --network commonswarm-net --add-host db.commonswarm.internal:172.31.0.10 \
 --env PGSERVICE=target --env PGSERVICEFILE=/run/service.conf --env PGPASSFILE=/run/pass \
 --volume "$SECRET_STAGE/issuer-live-service.conf:/run/service.conf:ro" \
 --volume "$SECRET_STAGE/issuer-live-pass:/run/pass:ro" \
 --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
 --entrypoint psql "$PSQL_IMAGE" -X --set=ON_ERROR_STOP=1 -Atq \
 --command "SELECT current_user='commonswarm_admin_issuer' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;" \
 >"$SECRET_STAGE/issuer-live-login.result" 2>"$SECRET_STAGE/issuer-live-login.log" || { printf 'FAIL ai-w6-issuer-live: TLS psql login with the installed credential expected exit 0 got failure; STOP\n' >&2; exit 1; }
test "$(cat "$SECRET_STAGE/issuer-live-login.result")" = t || { printf 'FAIL ai-w6-issuer-live: dedicated-role measurement expected t got non-t; STOP\n' >&2; exit 1; }
# The five forward catalogs, unmodified, all true (the W2b forward check, repeated live at W6).
for VERSION in 20261003000001 20261003000002 20261003000003 20261003000004 20261003000005; do
 printf '\\i /release/deploy/release-proofs/item-ai/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$PROOF_DIR/catalog.sql" || { printf 'FAIL ai-w6-issuer-live: catalog.sql expected written got failure; STOP\n' >&2; exit 1; }
 W6_FORWARD=$(ai_ro -Atq --file /proof/catalog.sql) || W6_FORWARD=error
 test "$W6_FORWARD" = t || { printf 'FAIL ai-w6-issuer-live: forward catalog %s expected t got other; STOP\n' "$VERSION" >&2; exit 1; }
done
printf 'PASS W6 issuer live: LOGIN with password, credential 0440 root:986, TLS login as the issuer, five forward catalogs true\n' >"$PROOF_DIR/issuer-live.txt" || { printf 'FAIL ai-w6-issuer-live: issuer-live.txt expected written got failure; STOP\n' >&2; exit 1; }
printf 'PASS ai-w6-issuer-live\n'
```

The C1 verification row is created here, by the release role, after the
activation checks and BEFORE activation (issuance CLOSED). It is reviewed data
in this plan: the exact client, callback, four-scope ceiling, full-account
eligibility, no delegation and the four tested flags (their evidence is the
admin-c1-smoke and admin-consent-client-policy gates of this window's receipt).
The box fetches the public client document once, pins the canonical JSON digest
(sorted keys, no whitespace; ASCII documents only, so Python's canonical form is
byte-identical to `canonicalAdminJson`) and requires it to equal the reviewed
`metadata_digest` from C1_INPUTS_FILE. An identical existing row is accepted (a
recovered rerun); a different row for this version, or another active version,
STOPs. The trigger `guard_verified_client` enforces public HTTPS redirects and
immutability.

```sh
# step: ai-w6-client-document
# readonly: yes
# host: HezLead box root, W6, before ai-w6-client-verification; public fetch only
set -euo pipefail
test "$WINDOW" = W6 || { printf 'FAIL ai-w6-client-document: window expected W6 got other; STOP\n' >&2; exit 1; }
test ! -e "$PROOF_DIR/c1-client-document.json" || { printf 'FAIL ai-w6-client-document: c1-client-document.json expected absent got present; STOP\n' >&2; exit 1; }
python3 - "$PROOF_DIR/c1-client-document.json" <<'PY'
import os,sys,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None
try:
    with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request('https://commonswarm.com/oauth/c1-smoke/client.json',headers={'User-Agent':'curl/8.7.1'}),timeout=15) as r:
        body=r.read(4097); ok=r.status==200 and r.headers.get('Content-Type','').split(';')[0]=='application/json' and len(body)<=4096
except Exception: ok=False
if not ok: raise SystemExit('FAIL ai-w6-client-document: public C1 client document expected 200-application/json-at-most-4096-bytes got other; STOP')
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as f: f.write(body)
print('PASS ai-w6-client-document: public C1 client document retained')
PY
```

```sh
# step: ai-w6-client-verification
# readonly: no
# host: HezLead box root, W6 after ai-w6-activation-checks and before ai-w6-activation-apply (issuance CLOSED)
set -euo pipefail
test "$WINDOW" = W6 || { printf 'FAIL ai-w6-client-verification: window expected W6 got other; STOP\n' >&2; exit 1; }
ai_deadline
test -f "$PROOF_DIR/W6-checks.txt" || { printf 'FAIL ai-w6-client-verification: W6-checks.txt expected present got missing; STOP\n' >&2; exit 1; }
test ! -e "$PROOF_DIR/activation-attempted.txt" || { printf 'FAIL ai-w6-client-verification: issuance expected not-yet-activated got activation-attempted; STOP\n' >&2; exit 1; }
C1_INPUTS_FILE=${C1_INPUTS_FILE:-$PROOF_DIR/C1-inputs.json}
test "$C1_INPUTS_FILE" = "$PROOF_DIR/C1-inputs.json" || { printf 'FAIL ai-w6-client-verification: C1_INPUTS_FILE expected the box proof copy got other; STOP\n' >&2; exit 1; }
python3 - "$C1_INPUTS_FILE" "$INPUTS_FILE" "$PROOF_DIR/c1-client-document.json" "$PROOF_DIR/client-verification.sql" <<'PY'
import hashlib,json,pathlib,re,sys
cfile,inputs,docfile,out=sys.argv[1:5]
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w6-client-verification: '+what+' expected '+expected+' got '+got+'; STOP')
c=json.load(open(cfile)); d=json.load(open(inputs))
need(all(c.get(k)==d.get(k) for k in ('release_sha','window_id','plan_sha256')),'C1 inputs binding','this-window','other')
v=c.get('verification_version'); h=c.get('metadata_digest')
need(type(v) is int and 0<v<1000000 and isinstance(h,str) and re.fullmatch('[0-9a-f]{64}',h) is not None,'C1 verification_version/metadata_digest','positive-integer-and-64-hex','other')
raw=pathlib.Path(docfile).read_bytes()
need(all(b<128 for b in raw),'client document','ASCII','non-ASCII')
doc=json.loads(raw)
def canonical(x):
    if isinstance(x,float): raise SystemExit('FAIL ai-w6-client-verification: client document expected no-floats got float; STOP')
    if isinstance(x,list): return '['+','.join(canonical(i) for i in x)+']'
    if isinstance(x,dict): return '{'+','.join(json.dumps(k)+':'+canonical(x[k]) for k in sorted(x))+'}'
    return json.dumps(x)
CLIENT='https://commonswarm.com/oauth/c1-smoke/client.json'; REDIRECT='https://commonswarm.com/oauth/c1-smoke/callback'
need(doc.get('client_id')==CLIENT and doc.get('application_type')=='web' and doc.get('redirect_uris')==[REDIRECT] and doc.get('token_endpoint_auth_method')=='none' and doc.get('dpop_bound_access_tokens') is True,'client document fields','reviewed-C1-client','other')
need(hashlib.sha256(canonical(doc).encode()).hexdigest()==h,'canonical document digest','C1 metadata_digest','other')
need(isinstance(d.get('gate_receipt_sha256'),str) and re.fullmatch('[0-9a-f]{64}',d['gate_receipt_sha256']) is not None,'gate_receipt_sha256','64-lowercase-hex','other')
evidence='gates:'+d['gate_receipt_sha256']+':admin-c1-smoke+admin-consent-client-policy'
cols="client_id,verification_version,application_type,registration_source,publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,full_account_eligible,delegation_eligible,native_loopback_eligible,pkce_s256_tested,dpop_tested,redirect_tested,origin_control_verified,review_evidence_ref,reviewed_by,active"
vals="'"+CLIENT+"',"+str(v)+",'web','cimd','Yulan Ventures (CommonSwarm C1 smoke)','https://commonswarm.com','"+h+"',ARRAY['"+REDIRECT+"']::text[],ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[],true,false,false,true,true,true,true,'"+evidence+"','HezLead',true"
same="v.application_type='web' AND v.registration_source='cimd' AND v.metadata_digest='"+h+"' AND v.redirect_uris=ARRAY['"+REDIRECT+"']::text[] AND v.scope_ceiling=ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[] AND v.full_account_eligible AND NOT v.delegation_eligible AND NOT v.native_loopback_eligible AND v.pkce_s256_tested AND v.dpop_tested AND v.redirect_tested AND v.origin_control_verified AND v.active AND v.withdrawn_at IS NULL"
owner=c.get('owner_user_id')
need(isinstance(owner,str) and re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',owner) is not None,'owner_user_id','UUID','other')
# The release role cannot read approvals/bindings or lock accounts. RESET ROLE to
# read and refuse live approvals before requesting any binding-owner account lock.
# Then prelock all binding owners in owner order (including terminal bindings),
# lock approval writes/absent-row inserts and recheck for live approvals.
# Restore the release role before verification writes; no privileges are added.
sql=("BEGIN; SET LOCAL ROLE commonswarm_admin_release; DO $c1$ DECLARE v commonswarm_oauth.admin_verified_clients%ROWTYPE; u commonswarm_oauth.admin_verified_clients%ROWTYPE; approval_withdrawn boolean; live_approval boolean; next_free integer; BEGIN "
 "PERFORM 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND NOT admin_issuance_enabled FOR UPDATE; "
 "IF NOT FOUND THEN RAISE EXCEPTION 'C1 verification requires issuance closed'; END IF; "
 "SELECT coalesce(max(verification_version),0)+1 INTO next_free FROM commonswarm_oauth.admin_verified_clients WHERE client_id='"+CLIENT+"'; "
 "IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='"+CLIENT+"' AND verification_version="+str(v)+" AND withdrawal_reason='c1-retry-superseded') THEN RAISE EXCEPTION 'FAIL ai-w6-client-verification: verification_version "+str(v)+" expected reusable got superseded; use verification_version % for the next W6; STOP',next_free; END IF; "
 "SELECT * INTO u FROM commonswarm_oauth.admin_verified_clients WHERE client_id='"+CLIENT+"' AND active FOR UPDATE; "
 "IF FOUND THEN RESET ROLE; PERFORM 1 FROM commonswarm_oauth.admin_client_owner_approvals a WHERE a.client_id=u.client_id AND a.verification_version=u.verification_version FOR SHARE; SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals a WHERE a.client_id=u.client_id AND a.verification_version=u.verification_version AND a.withdrawn_at IS NULL) INTO live_approval; SELECT a.withdrawn_at IS NOT NULL INTO approval_withdrawn FROM commonswarm_oauth.admin_client_owner_approvals a WHERE a.owner_user_id='"+owner+"'::uuid AND a.client_id=u.client_id AND a.verification_version=u.verification_version FOR SHARE; "
 "IF u.verification_version="+str(v)+" THEN IF approval_withdrawn THEN RAISE EXCEPTION 'FAIL ai-w6-client-verification: owner approval at verification_version "+str(v)+" expected reusable got withdrawn; use verification_version "+str(v+1)+" for the next W6; STOP'; END IF; "
 "ELSE IF live_approval THEN RAISE EXCEPTION 'FAIL ai-w6-client-verification: verification_version % expected no live approvals from any owner got live approval; STOP',u.verification_version; END IF; IF NOT coalesce(approval_withdrawn,false) THEN RAISE EXCEPTION 'another active C1 verification version'; END IF; "
 "PERFORM 1 FROM swarm.admin_accounts a WHERE EXISTS (SELECT 1 FROM commonswarm_oauth.admin_grant_bindings b WHERE b.client_id=u.client_id AND b.verification_version=u.verification_version AND b.owner_user_id=a.owner_user_id) ORDER BY a.owner_user_id FOR UPDATE OF a; LOCK TABLE commonswarm_oauth.admin_client_owner_approvals IN SHARE ROW EXCLUSIVE MODE; IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals a WHERE a.client_id=u.client_id AND a.verification_version=u.verification_version AND a.withdrawn_at IS NULL) THEN RAISE EXCEPTION 'FAIL ai-w6-client-verification: verification_version % expected no live approvals from any owner got live approval; STOP',u.verification_version; END IF; SET LOCAL ROLE commonswarm_admin_release; "
 "UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='c1-retry-superseded' WHERE client_id=u.client_id AND verification_version=u.verification_version; END IF; SET LOCAL ROLE commonswarm_admin_release; END IF; "
 "SELECT * INTO v FROM commonswarm_oauth.admin_verified_clients WHERE client_id='"+CLIENT+"' AND verification_version="+str(v)+"; "
 "IF FOUND THEN IF NOT ("+same+") THEN RAISE EXCEPTION 'existing C1 verification differs'; END IF; "
 "ELSE IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='"+CLIENT+"' AND active) THEN RAISE EXCEPTION 'another active C1 verification version'; END IF; "
 "INSERT INTO commonswarm_oauth.admin_verified_clients("+cols+") VALUES ("+vals+"); END IF; END $c1$; COMMIT;\n")
pathlib.Path(out).write_text(sql)
PY
ai_db -q --file /proof/client-verification.sql >/dev/null || { printf 'FAIL ai-w6-client-verification: release-role insert of the reviewed C1 verification expected committed got refused; STOP\n' >&2; exit 1; }
printf 'PASS reviewed C1 verification row present, active and canonical-digest bound\n' >"$PROOF_DIR/C1-client-verification.txt"
```


```sh
# step: ai-w6-activation-apply
# readonly: no
# host: HezLead, box root; approved activation only
(
C1_CLOSED_CONFIRMED=0 W6_APPLY_TIMER_HELD=0
C1_BLOCK_DONE=0
w6_apply_exit() {
 local status=$?
 trap - EXIT
 if test "$status" = 0 && test "${C1_BLOCK_DONE:-0}" != 1; then status=2; fi
 # Recovery once this apply has stopped the timer (from just before its stop on).
 if test "$status" != 0 && test "$W6_APPLY_TIMER_HELD" = 1; then
  ( ai_run ai-w4-timer-recovery ) || printf 'FAIL ai-w6-activation-apply: recycle timer re-arm after a failed apply expected active got failure; STOP\n' >&2
 fi
 # Status contract (first statement of the block): 1 only after a confirmed CLOSED readback; anything else UNKNOWN.
 if test "$status" = 1 && test "${C1_CLOSED_CONFIRMED:-0}" != 1; then status=2; fi
 exit "$status"
}
trap w6_apply_exit EXIT
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W6' and isinstance(a,dict) and a.get('action')=='activate-admin-issuance-and-smoke', 'FAIL W6 activation approval required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) for k in ('release_sha','window_id','plan_sha256')), 'FAIL W6 approval binding; STOP'
PY
test "$WINDOW" = W6
ai_run ai-w6-readiness
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$EDGE_MEASUREMENT_FILE" ai-w6-activation-apply <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^```sh\n(.*?)^```$',verified_plan(sys.argv[1],sys.argv[2],sys.argv[4]).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-edge-receipt\n')]; assert len(found)==1
# argv[3] is the shell's EDGE_MEASUREMENT_FILE; an unexported variable still reaches Python.
subprocess.run(['/bin/bash'],input=found[0],text=True,check=True,env=dict(os.environ,PLAN_FILE=sys.argv[1],INPUTS_FILE=sys.argv[2],EDGE_MEASUREMENT_FILE=sys.argv[3]))
PY
ai_run ai-inputs
ai_run ai-w6-activation-approval
ai_run ai-gates-bind
ai_deadline
test -f "$PROOF_DIR/W6-checks.txt"
test ! -e "$PROOF_DIR/activation-attempted.txt"
OAUTH_TARGET=/home/commonswarm/oauth/releases/$RELEASE_SHA
test "$(readlink -f /home/commonswarm/oauth/current)" = "$OAUTH_TARGET"
test "$(stat -c '%a %u %g' /etc/commonswarm-oauth/admin-issuer-database-credentials)" = '440 0 986'
test -f /etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf
test -f "$PROOF_DIR/C1-client-verification.txt" || { printf 'FAIL ai-w6-activation-apply: C1-client-verification.txt expected present got missing; STOP\n' >&2; exit 1; }
# HezLead ruling: the recycle timer stays STOPPED from here until ai-w6-finish re-arms it. A failed apply
# re-arms it at once (the hooks are marked complete blocks installed in W4; no generated operator script).
W6_APPLY_TIMER_HELD=1
systemctl stop "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-activation-apply: recycle timer stop expected success got failure; STOP\n' >&2; exit 1; }
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive || { printf 'FAIL ai-w6-activation-apply: recycle service expected inactive got other; STOP\n' >&2; exit 1; }
# The shared remeasure owns this fresh measurement; it writes the W6 receipt and validates it.
EDGE_MEASUREMENT_OUT=$PROOF_DIR/edge-measurement.json
( ai_run ai-edge-remeasure ) || { W6_REMEASURE_STATUS=$? W6_REMEASURE_CALLER=ai-w6-activation-apply; printf 'FAIL ai-w6-activation-apply: edge remeasure expected PASS got failure; STOP\n' >&2; if test "$W6_REMEASURE_STATUS" = 1; then C1_CLOSED_CONFIRMED=1; printf 'FAIL %s: issuance CLOSED (remeasure failure close confirmed by readback); STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 1; fi; printf 'FAIL %s: issuance state UNKNOWN after the remeasure failure (may be OPEN); run ai-emergency-close; STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 2; }
unset EDGE_MEASUREMENT_OUT
python3 - "$SECRET_STAGE/service.env" "$SECRET_STAGE/service.active.env" <<'PY'
import pathlib,sys
rows=pathlib.Path(sys.argv[1]).read_text().splitlines()
keys=('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE')
assert not any(r.split('=',1)[0] in keys for r in rows), 'FAIL activation baseline must be unset; STOP'
pathlib.Path(sys.argv[2]).write_text('\n'.join(rows+['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1'])+'\n')
pathlib.Path(sys.argv[2]).chmod(0o600)
PY
cmp -s /etc/commonswarm-oauth/service.env "$SECRET_STAGE/service.env"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/activation-attempted.txt"
install -o root -g root -m 0600 "$SECRET_STAGE/service.active.env" /etc/commonswarm-oauth/service.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.yaml" -f "$OAUTH_TARGET/deploy/mcp-auth/compose.management.yaml" \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.admin-issuer.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/activation.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
python3 - "$RELEASE_SHA" <<'PY'
import json,subprocess,sys
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1'],stderr=subprocess.DEVNULL))[0]
e=dict(x.split('=',1) for x in c['Config']['Env'])
assert e['MCP_OAUTH_ADMIN_ISSUANCE_ENABLED']=='1'
assert e['MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE']=='/run/commonswarm-oauth/admin-issuer-database-credentials'
assert c['Config']['User']=='996:986'
m=[m for m in c['Mounts'] if m['Destination']=='/run/commonswarm-oauth/admin-issuer-database-credentials']
assert len(m)==1 and m[0]['Source']=='/etc/commonswarm-oauth/admin-issuer-database-credentials' and m[0]['RW'] is False
assert subprocess.check_output(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',c['Image']],text=True).strip()==sys.argv[1]
PY
python3 - "$INPUTS_FILE" "$PROOF_DIR/activate.sql" "$PROOF_DIR/edge-measurement.json" <<'PY'
import json,pathlib,re,sys
d=json.load(open(sys.argv[1])); sha=d['release_sha']; h=d['gate_receipt_sha256']; m=json.load(open(sys.argv[3]))
assert type(m.get('generation')) is int and m['generation']>0 and m.get('invalidated_at','missing') is None, 'FAIL generation/invalidated_at; STOP'
gen=str(m['generation'])
assert re.fullmatch('[0-9a-f]{40}',sha) and re.fullmatch('[0-9a-f]{64}',h)
# M4 grants migration_checksum_failures() to the runtime and command roles only: the locked gate runs as the
# session's admin user, then the same transaction takes the release role for the switch.
sql="BEGIN; DO $$ BEGIN PERFORM 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE; IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksum_failures()) OR NOT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND NOT admin_issuance_enabled AND legacy_closed AND auth_contract_version=2 AND approved_edge_release_sha='"+sha+"' AND measured_edge_release_sha='"+sha+"' AND release_generation="+gen+" AND measured_generation=release_generation AND invalidated_at IS NULL AND measured_at IS NOT NULL) THEN RAISE EXCEPTION 'activation generation/invalidated_at checks refused'; END IF; END $$; SET LOCAL ROLE commonswarm_admin_release; "
sql+="UPDATE commonswarm_oauth.admin_cutover_state SET lane8_evidence_digest='"+h+"',admin_issuance_enabled=true WHERE singleton; COMMIT;\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
ai_db -q --file /proof/activate.sql >/dev/null
printf 'Apply body completed; recycle timer HELD until ai-w6-finish: W6 overlay/env/cutover active; require outside gate probe before close\n'
# Reached only by running to the end: an early exit (an expansion error can leave $? at 0) is never success.
C1_BLOCK_DONE=1
)
```

```sh
# step: ai-w6-activation-probes
# readonly: probe
# host: Mac outside ingress, then HezLead box receipt
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
for method in ['GET','HEAD']:
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with urllib.request.urlopen(req,timeout=15) as r:
        body=r.read(4097)
        assert r.status==200 and r.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in r.headers.get('Cache-Control','') and len(body)<=4096
        assert json.loads(body)=={'state':'open'} if method=='GET' else body==b''
print('PASS outside GET/HEAD gate open + CORS; exact approved combined release')
PY
```

```sh
# step: ai-w6-activation-readback
# readonly: no
# host: HezLead box root; after outside ai-w6-activation-probes PASS
set -euo pipefail
test "$WINDOW" = W6
test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND legacy_closed AND lane8_evidence_digest IS NOT NULL AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
printf 'PASS W6 measured release, overlay/env and public gate open\n' >"$PROOF_DIR/W6-probes.txt"
```

```sh
# step: ai-w6-activation-rollback
# readonly: no
# host: HezLead box root; remove activation env/overlay and close cutover
(
# Installed as the FIRST statement, before set -u and the first rollback operation: any exit re-arms the held recycle timer; the original failure is
# kept and a failed re-arm is reported (and fails a successful rollback).
C1_BLOCK_DONE=0
w6_rollback_exit() {
 local status=$?
 trap - EXIT
 if test "$status" = 0 && test "${C1_BLOCK_DONE:-0}" != 1; then status=2; fi
 if test -z "${EDGE_RECYCLE_TIMER:-}"; then
  test "$status" = 0 || printf 'FAIL ai-w6-activation-rollback: recycle timer name unknown at exit; re-arm it by hand with ai-w4-timer-recovery; STOP\n' >&2
  test "$status" != 0 || status=3
 elif ! systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"; then
  systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-activation-rollback: recycle timer re-arm on exit expected success got failure; STOP\n' >&2; test "$status" != 0 || status=3; }
  systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-activation-rollback: recycle timer expected active on exit got inactive; STOP\n' >&2; test "$status" != 0 || status=3; }
 fi
 # Status contract: a failed rollback never claims CLOSED (1 becomes 2, UNKNOWN); other codes are kept.
 if test "$status" = 1; then status=2; fi
 exit "$status"
}
trap w6_rollback_exit EXIT
set -euo pipefail
# guard_cutover_state refuses a generation change while issuance is open: close first, then invalidate, one transaction.
ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false WHERE singleton; UPDATE commonswarm_oauth.admin_cutover_state SET invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;" >/dev/null
OAUTH_TARGET=$(readlink -f /home/commonswarm/oauth/current)
python3 - "$OAUTH_TARGET" "$SECRET_STAGE/service.closed.env" <<'PY'
import pathlib,re,sys
assert re.fullmatch(r'/home/commonswarm/oauth/releases/[0-9a-f]{40}',sys.argv[1])
p=pathlib.Path('/etc/commonswarm-oauth/service.env'); rows=p.read_text().splitlines()
keys=('MCP_OAUTH_ADMIN_ISSUANCE_ENABLED','MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE')
out=pathlib.Path(sys.argv[2]); out.write_text('\n'.join(r for r in rows if r.split('=',1)[0] not in keys)+'\n'); out.chmod(0o600)
PY
install -o root -g root -m 0600 "$SECRET_STAGE/service.closed.env" /etc/commonswarm-oauth/service.env
docker compose --project-name commonswarm-oauth --env-file /etc/commonswarm-oauth/compose.env \
 -f "$OAUTH_TARGET/deploy/mcp-auth/compose.yaml" -f "$OAUTH_TARGET/deploy/mcp-auth/compose.management.yaml" \
 up -d --no-build --pull never --force-recreate oauth >"$SECRET_STAGE/activation-rollback.log" 2>&1
timeout 90 /bin/bash -c 'until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-oauth-oauth-1)" = healthy; do sleep 2; done'
python3 - <<'PY'
import json,subprocess,urllib.request
c=json.loads(subprocess.check_output(['docker','inspect','commonswarm-oauth-oauth-1'],stderr=subprocess.DEVNULL))[0]
e=dict(x.split('=',1) for x in c['Config']['Env'])
assert 'MCP_OAUTH_ADMIN_ISSUANCE_ENABLED' not in e and 'MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE' not in e
assert not any(m['Destination']=='/run/commonswarm-oauth/admin-issuer-database-credentials' for m in c['Mounts'])
with urllib.request.urlopen('http://127.0.0.1:3490/admin/gate',timeout=15) as r: assert json.loads(r.read(4096))=={'state':'closed'}
PY
test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
# Re-arm the recycle timer W6 held; also the emergency-close path.
systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-activation-rollback: recycle timer start expected success got failure; STOP\n' >&2; exit 1; }
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-activation-rollback: recycle timer expected active got inactive; STOP\n' >&2; exit 1; }
printf 'PASS W6 env/overlay removed; DB closed; recycle timer active; history and issuer credential retained\n' >"$PROOF_DIR/activation-rollback.txt"
# Reached only by running to the end: an early exit (an expansion error can leave $? at 0) is never success.
C1_BLOCK_DONE=1
)
```

```sh
# step: ai-emergency-close
# readonly: no
# host: HezLead box root; W6–W7 recovery, never reopens opaque authentication
set -euo pipefail
ai_run ai-w6-activation-rollback
printf 'Issuance closed; existing grants require the W6 human revoke/approval withdrawal or separately approved incident reconciliation\n'
```

## W6: C1 hosted OAuth admin smoke

The delivered `scripts/admin-smoke.mjs` owns PKCE, DPoP proofs/nonces, code
exchange, init/list/read/actions, saved command IDs, workspace/seat creation,
seat revoke, refresh and access-fence verification. Keep the same process alive
through the human fence: its key/token state is in memory. No browser starts
from these blocks. HezLead's assigned browser worker follows the pointer's
granular consent_choices (workspace, scopes, home=false, full_account=false)
only after `/Users/yulanbot/work/BROWSER-READY` exists. The four-scope runner
request is unchanged; the live smoke does not present or confirm full account.

D8 keeps every runner file inside its own fresh secret directory. W6 publishes
only the 0600 nonsecret `/Users/yulanbot/work/dcr-rt/c1-smoke.pointer`: absolute
authorize_url_file and callback_file paths, consent_choices (exact existing
smoke workspace name, scopes from the canonical runner request validated
against the spec, home=false, full_account=false: granular workspaces:create
with the created-workspace policy), and expires_at UTC. The new workspace created by the runner is
accepted residue; it is not the existing workspace selected for consent.

D9 approval is account-wide for this owner/client/version. Approve immediately
before the assigned worker consents; in this same W6 withdraw that approval
and revoke the grant/family. Granular consent does not cover future owned spaces;
the smoke scope ceiling does not make approval workspace-scoped. Record
approval_at, withdrawn_at, revoked_at and the actual refused follow-up call.

`C1_INPUTS_FILE` is a regular absolute nonsecret JSON supplied by HezLead:
release_sha/window_id/plan_sha256; owner_user_id, existing smoke_workspace_id
and its exact smoke_workspace_name; verification_version, metadata_digest;
target_file and owner file-store state_directory. No extra revision approvals.
W5 invokes the companion site's existing site2-07-manifest-close with its
strengthened browser ownership helper; ai-w5-closed verifies that plan's actual
CLOSE.txt (CLOSED=yes, OUTCOME=released, PIN_RELEASED=yes and manifest digest).
The same-build site-build-qa gate requires the new ownership implementation.

`W5_CLOSED_FILE` names the verified W5 close; `BROWSER_READY_FILE` must name
`/Users/yulanbot/work/BROWSER-READY` and be newer than that close. Copy the
nonsecret readiness file to the box for ai-open and revalidation, retaining
its modification time. The box input names that copy; the Mac preflight checks
the canonical path. `keep_open` is optional in INPUTS_FILE, defaults false;
true requires a separate bound `keep_open_approval` action keep-admin-issuance-open.
The verification row is an external reviewed input prepared by the release
role, not created by owner approval. PASS10 pins lowercase SHA-256 of
`canonicalAdminJson(fetched_document)` via the production `adminDigest`.
Never hash provider-normalized defaults or confuse the document's byte digest
with its canonical JSON digest. Approval uses the exact version after the
published document, reviewed digest and DB row are reconciled.

### W6 producers (contracts; each is produced fresh for THIS release and W6 window)

Nothing from an earlier release or window is reused. The 2026-10-03 pointer,
callback, consent receipts and BROWSER-READY marker belong to other releases or
windows; every one is replaced: the pointer is created exclusively per W6
window with that window's expiry, and the consent receipts are bound to
RELEASE_SHA.

- **BROWSER-READY** (`/Users/yulanbot/work/BROWSER-READY`, Mac). Producer: HezLead
  on Tom's unlocked Mac, by `touch` AFTER the W5 close at this release and
  shortly before the W6 open. Contract: a regular non-symlink file; only its
  modification time matters (newer than the W5 `closed.txt` time and not in the
  future: ai-w6-readiness, ai-w6-preflight, ai-open). Content is ignored. A file
  touched before the W5 close STOPs W6; touch it again after the close.
- **Smoke pointer** (`/Users/yulanbot/work/dcr-rt/c1-smoke.pointer`, Mac). Producer:
  the plan's own ai-w6-pointer, after ai-w6-start, once per W6 window (exclusive
  create; it must not exist). Format: one JSON line, 0600, sorted keys
  `authorize_url_file`, `callback_file` (absolute paths in this run's
  `/private/tmp/anvil-secret.*` stage), `consent_choices` {`workspace_name` (the
  C1 smoke workspace), `scopes`, `home`: false, `full_account`: false}, `expires_at`
  = INPUTS `window_end_utc`. Consumer: HezLead's assigned browser consent worker
  (the existing consent autorun, pointed at this pointer path): it waits for the
  0600 authorize file, refuses an expired pointer, follows consent_choices
  exactly (granular: no full-account second confirmation), and atomically writes
  the full callback URL (0600) to `callback_file` without logging it.
  ai-w6-secret-close removes the stage and the pointer.
- **C1_INPUTS_FILE**: produced by ai-w6-c1-inputs below (Mac, owner session).
  HezLead supplies only the existing smoke workspace (`C1_SMOKE_WORKSPACE_ID`,
  exact `C1_SMOKE_WORKSPACE_NAME`) and `C1_VERIFICATION_VERSION`. The
  block derives the rest: owner_user_id from the owner's refreshed file-store
  session, state_directory = `defaultCredentialStateDirectory()`, target_file =
  its `current-target.json` (keys url, anonKey), and metadata_digest from the
  fetched public client document.

```sh
# step: ai-w6-c1-inputs
# readonly: no
# host: HezLead Mac, clean checkout at RELEASE_SHA with dependencies installed; owner file-store session; writes C1_INPUTS_FILE once
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${INPUTS_FILE:?}" "${C1_INPUTS_FILE:?FAIL ai-w6-c1-inputs: C1_INPUTS_FILE expected absolute-new-file got unset; STOP}"
: "${C1_SMOKE_WORKSPACE_ID:?}" "${C1_SMOKE_WORKSPACE_NAME:?}" "${C1_VERIFICATION_VERSION:?}"
C1_INPUTS_RELEASE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE") || { printf 'FAIL ai-w6-c1-inputs: INPUTS release_sha expected readable got failure; STOP\n' >&2; exit 1; }
test "$(git rev-parse HEAD)" = "$C1_INPUTS_RELEASE" || { printf 'FAIL ai-w6-c1-inputs: checkout HEAD expected release-sha got mismatch; STOP\n' >&2; exit 1; }
node --import tsx --input-type=module - "$INPUTS_FILE" "$C1_INPUTS_FILE" "$C1_SMOKE_WORKSPACE_ID" "$C1_SMOKE_WORKSPACE_NAME" "$C1_VERIFICATION_VERSION" <<'JS'
import { open, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { credentialStore, defaultCredentialStateDirectory } from './src/cloud/storage.ts';
import { readCurrentTarget } from './src/cloud/current-target.ts';
import { refreshedCredential } from './src/cloud/auth.ts';
import { canonicalAdminJson } from './src/protocol/admin-policy.ts';
const [inputs,out,workspaceId,workspaceName,version]=process.argv.slice(2);
try {
 const d=JSON.parse(await readFile(inputs,'utf8'));
 if(d.window!=='W6' || !isAbsolute(out)) throw Error('window/output');
 if(!/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(workspaceId)) throw Error('workspace id');
 if(workspaceName.length<1 || workspaceName.length>200 || /[\u0000-\u001f]/.test(workspaceName) || /bearer|https?:\/\/|eyJ[A-Za-z0-9_-]+\.|(?:token|secret|password)=/i.test(workspaceName)) throw Error('workspace name');
 if(!/^[1-9][0-9]{0,5}$/.test(version)) throw Error('verification version');
 const stateDirectory=defaultCredentialStateDirectory();
 const target=await readCurrentTarget(); if(target?.url!=='https://api.commonswarm.com') throw Error('target');
 const store=await credentialStore({target,stateDirectory,forceFile:true,warn:()=>{}});
 const human=await refreshedCredential(target,store);
 const response=await fetch('https://commonswarm.com/oauth/c1-smoke/client.json',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok || response.headers.get('content-type')?.split(';')[0]!=='application/json') throw Error('document');
 const text=await response.text(); if(Buffer.byteLength(text)>4096) throw Error('document size');
 const doc=JSON.parse(text); if(doc.client_id!=='https://commonswarm.com/oauth/c1-smoke/client.json') throw Error('client id');
 const c={release_sha:d.release_sha,window_id:d.window_id,plan_sha256:d.plan_sha256,owner_user_id:human.userId,smoke_workspace_id:workspaceId,
   smoke_workspace_name:workspaceName,verification_version:Number(version),metadata_digest:createHash('sha256').update(canonicalAdminJson(doc)).digest('hex'),
   target_file:join(stateDirectory,'current-target.json'),state_directory:stateDirectory};
 const fd=await open(out,'wx',0o600); await fd.writeFile(JSON.stringify(c)+'\n'); await fd.close();
 console.log('PASS ai-w6-c1-inputs: C1 inputs written; owner, target and digest derived; no credentials emitted');
} catch { console.error('FAIL ai-w6-c1-inputs: C1 inputs expected derived got refused; STOP'); process.exitCode=1; }
JS
```

```sh
# step: ai-w6-preflight
# readonly: yes
# host: Mac Bash 3.2; no files/network/mutations before assignment checks
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W6' and isinstance(a,dict) and a.get('action')=='activate-admin-issuance-and-smoke', 'FAIL W6 human consent assignment required; STOP'
assert a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref') and all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W6 approval binding; STOP'
PY
: "${C1_INPUTS_FILE:?C1 approval inputs absent; STOP}"
python3 - "$INPUTS_FILE" "$C1_INPUTS_FILE" <<'PY'
import json,pathlib,re,sys
d=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2])
assert p.is_absolute() and p.is_file() and not p.is_symlink(), 'FAIL C1 regular input required; STOP'
c=json.loads(p.read_text())
assert set(c)==set('release_sha window_id plan_sha256 owner_user_id smoke_workspace_id smoke_workspace_name verification_version metadata_digest target_file state_directory'.split()), 'FAIL exact C1 keys; STOP'
assert all(c.get(k)==d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL C1 window binding; STOP'
for k in ['owner_user_id','smoke_workspace_id']: assert re.fullmatch(r'[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}',c.get(k,'')), 'FAIL C1 owner/workspace input; STOP'
assert type(c.get('verification_version')) is int and c['verification_version']>0
assert re.fullmatch('[0-9a-f]{64}',c.get('metadata_digest',''))
assert isinstance(c.get('smoke_workspace_name'),str) and 0<len(c['smoke_workspace_name'])<=200 and not any(ord(x)<32 for x in c['smoke_workspace_name']), 'FAIL exact smoke workspace name; STOP'
for k in ['target_file','state_directory']:
    path=pathlib.Path(c.get(k,'')); assert path.is_absolute() and path.exists() and not path.is_symlink(), 'FAIL C1 owner session input; STOP'
print('PASS C1 assignment, D8 private paths and D9 account-wide approval inputs')
PY
: "${W5_CLOSED_FILE:?}" "${BROWSER_READY_FILE:?}"
test "$BROWSER_READY_FILE" = /Users/yulanbot/work/BROWSER-READY
python3 - "$INPUTS_FILE" "$W5_CLOSED_FILE" "$BROWSER_READY_FILE" <<'PY'
import datetime,json,pathlib,re,sys
def box_utc(value):
    # Shared strict parser for box-written times: an AWARE UTC time, offset +00:00 or Z, 0-6 fraction digits.
    # Any other offset, a naive time or a non-ISO value is None, which every caller refuses.
    m=re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)',value) if isinstance(value,str) else None
    if m is None: return None
    try: return datetime.datetime(*(int(x) for x in m.groups()[:6]),int((m.group(7) or '0').ljust(6,'0')),tzinfo=datetime.timezone.utc)
    except ValueError: return None
d=json.load(open(sys.argv[1])); close,ready=map(pathlib.Path,sys.argv[2:])
assert all(p.is_absolute() and p.is_file() and not p.is_symlink() for p in (close,ready)), 'FAIL W6 fresh BROWSER-READY required; STOP'
w=json.load(open(close.parent/'inputs.json')); assert w['release_sha']==d['release_sha'] and w['window']=='W5'
assert json.load(open(close.parent/'W5-closed.json'))['state']=='closed'
closed_at=box_utc(close.read_text().strip()); assert closed_at is not None, 'FAIL W5 closed.txt expected aware-UTC-ISO-8601-time got other; STOP'
t=closed_at.timestamp()
assert ready.stat().st_mtime>t and ready.stat().st_mtime<=datetime.datetime.now(datetime.timezone.utc).timestamp(), 'FAIL W6 BROWSER-READY must be newer than W5 close; STOP'
PY

```

```sh
# step: ai-w6-prepare
# readonly: no
# host: HezLead Mac; only after ai-w6-preflight/ai-inputs/ai-gates PASS
set -euo pipefail
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
test "$(git rev-parse HEAD)" = "$RELEASE_SHA" || { printf 'FAIL ai-w6-prepare: checkout HEAD expected release-sha got mismatch; STOP\n' >&2; exit 1; }
C1_GIT_STATUS=$(git status --porcelain)
test -z "$C1_GIT_STATUS" || { printf 'FAIL ai-w6-prepare: worktree expected clean got dirty; STOP\n' >&2; exit 1; }
C1_PROOF_DIR=/Users/yulanbot/work/hm37-live-release/c1-${RELEASE_SHA}-${WINDOW_ID}
test ! -e "$C1_PROOF_DIR" || { printf 'FAIL ai-w6-prepare: C1_PROOF_DIR expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$C1_PROOF_DIR" || { printf 'FAIL ai-w6-prepare: C1_PROOF_DIR expected not-symlink got symlink; STOP\n' >&2; exit 1; }
mkdir -p "$C1_PROOF_DIR" /Users/yulanbot/work/dcr-rt
chmod 0700 "$C1_PROOF_DIR"
install -m 0600 "$C1_INPUTS_FILE" "$C1_PROOF_DIR/C1-inputs.json"
```

```sh
# step: ai-w6-transfer
# readonly: no
# host: HezLead Mac; nonsecret receipts only, whole block per selected file
set -euo pipefail
: "${C1_TRANSFER_DIRECTION:?upload or download}" "${C1_TRANSFER_FILE:?}" "${C1_PROOF_DIR:?}"
# Inside the fence window (C1_FENCE_DEADLINE, set by ai-w6-fence-driver) every transport is bounded by the
# remaining deadline, a stalled established session included; ssh keepalives bound it everywhere.
c1_transport() {
 if test -n "${C1_FENCE_DEADLINE:-}"; then
  C1_LEFT=$(( C1_FENCE_DEADLINE - $(date +%s) ))
  test "$C1_LEFT" -gt 0 || { printf 'FAIL ai-w6-transfer: fence deadline expected remaining got expired; STOP\n' >&2; return 1; }
  perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "$C1_LEFT" "$@"
 else
  "$@"
 fi
}
C1_BOX_PROOF=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-W6-${WINDOW_ID}
case "$C1_TRANSFER_DIRECTION:$C1_TRANSFER_FILE" in
 upload:C1-inputs.json|upload:agent.json|upload:agent-final.json|upload:client-withdraw.json|upload:C1.json|upload:C1-cleanup.txt|upload:C1-close-state.json)
  test -f "$C1_PROOF_DIR/$C1_TRANSFER_FILE" || { printf 'FAIL ai-w6-transfer: upload file expected regular-file got missing; STOP\n' >&2; exit 1; }
  test ! -L "$C1_PROOF_DIR/$C1_TRANSFER_FILE" || { printf 'FAIL ai-w6-transfer: upload file expected not-symlink got symlink; STOP\n' >&2; exit 1; }
  C1_UPLOAD_STAGE=$(c1_transport ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 'umask 077; mktemp -d /tmp/admin-c1.XXXXXX') || { printf 'FAIL ai-w6-transfer: upload stage expected mktemp got failure; STOP\n' >&2; exit 1; }
  case "$C1_UPLOAD_STAGE" in /tmp/admin-c1.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) ;; *) printf 'FAIL ai-w6-transfer: upload stage expected /tmp/admin-c1.XXXXXX got other; STOP\n' >&2; exit 1;; esac
  C1_UPLOAD="$C1_UPLOAD_STAGE/$C1_TRANSFER_FILE"
  c1_transport scp -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -p "$C1_PROOF_DIR/$C1_TRANSFER_FILE" "ops@100.115.66.74:$C1_UPLOAD"
  printf -v C1_REMOTE 'sudo -n install -o root -g root -m 0600 %q %q' "$C1_UPLOAD" "$C1_BOX_PROOF/$C1_TRANSFER_FILE"
  c1_transport ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 "$C1_REMOTE"
  C1_STAGE_RM='import os,stat,sys,shutil
p=sys.argv[1]
if os.path.islink(p) or not os.path.isdir(p):
    sys.stderr.write("FAIL ai-w6-transfer: upload stage expected owner-matched-0700-directory after install got other; STOP\n"); sys.exit(1)
st=os.lstat(p)
if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
    sys.stderr.write("FAIL ai-w6-transfer: upload stage expected owner-matched-0700-directory after install got other; STOP\n"); sys.exit(1)
shutil.rmtree(p)
'
  printf -v C1_REMOTE 'python3 -c %q %q' "$C1_STAGE_RM" "$C1_UPLOAD_STAGE"
  c1_transport ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 "$C1_REMOTE"
  ;;
 download:C1-client-check.txt|download:C1-audit.json|download:C1-fence.txt|download:C1-finish.json)
  C1_DEST="$C1_PROOF_DIR/$C1_TRANSFER_FILE"
  test ! -L "$C1_DEST" || { printf 'FAIL ai-w6-transfer: download target expected not-symlink got symlink; STOP\n' >&2; exit 1; }
  c1_download_reuse=0
  if test -e "$C1_DEST"; then
   test -f "$C1_DEST" || { printf 'FAIL ai-w6-transfer: download target expected regular-file got other; STOP\n' >&2; exit 1; }
   if test -s "$C1_DEST"; then
    if python3 - "$C1_TRANSFER_FILE" "$C1_DEST" <<'PY'
import json,sys
name,path=sys.argv[1],sys.argv[2]
raw=open(path,'rb').read()
if not raw.strip(): raise SystemExit(1)
if name.endswith('.json'):
    r=json.loads(raw)
    if name=='C1-audit.json':
        assert set(r['audit_counts'])=={'init','list','read','action'} and all(type(n) is int and n>0 for n in r['audit_counts'].values())
    elif name=='C1-finish.json':
        assert r.get('state') in ('open','closed') and isinstance(r.get('explicit_keep_open'),bool)
    else:
        assert isinstance(r,dict)
else:
    assert raw.decode().startswith('PASS')
PY
    then
     C1_LOCAL_DIGEST=$(shasum -a 256 "$C1_DEST" | awk '{print $1}')
     printf -v C1_REMOTE 'sudo -n sha256sum %q' "$C1_BOX_PROOF/$C1_TRANSFER_FILE"
     C1_SOURCE_DIGEST=$(c1_transport ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 "$C1_REMOTE" | awk '{print $1}') || C1_SOURCE_DIGEST=
     if test -n "$C1_SOURCE_DIGEST" && test "$C1_LOCAL_DIGEST" = "$C1_SOURCE_DIGEST"; then
      c1_download_reuse=1
     fi
    fi
   fi
  fi
  if test "$c1_download_reuse" != 1; then
   C1_DL_STAGE=$(mktemp "$C1_PROOF_DIR/.${C1_TRANSFER_FILE}.XXXXXX") || { printf 'FAIL ai-w6-transfer: download staging file expected created got failure; STOP\n' >&2; exit 1; }
   case "$C1_DL_STAGE" in "$C1_PROOF_DIR"/.${C1_TRANSFER_FILE}.*) ;; *) printf 'FAIL ai-w6-transfer: download staging path expected under C1_PROOF_DIR got other; STOP\n' >&2; exit 1;; esac
   printf -v C1_REMOTE 'sudo -n cat %q' "$C1_BOX_PROOF/$C1_TRANSFER_FILE"
   umask 077
   if ! c1_transport ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 "$C1_REMOTE" >"$C1_DL_STAGE"; then
    rm -- "$C1_DL_STAGE"
    printf 'FAIL ai-w6-transfer: download transport expected success got failure; STOP\n' >&2; exit 1
   fi
   if ! test -s "$C1_DL_STAGE"; then
    rm -- "$C1_DL_STAGE"
    printf 'FAIL ai-w6-transfer: download expected nonempty got empty; STOP\n' >&2; exit 1
   fi
   if test "$C1_TRANSFER_FILE" = C1-audit.json; then
    python3 - "$C1_DL_STAGE" <<'PY' || { rm -- "$C1_DL_STAGE"; printf 'FAIL ai-w6-transfer: downloaded C1-audit.json expected four committed kinds got other; STOP\n' >&2; exit 1; }
import json,sys
r=json.load(open(sys.argv[1])); assert set(r['audit_counts'])=={'init','list','read','action'} and all(type(n) is int and n>0 for n in r['audit_counts'].values())
PY
   fi
   mv -f "$C1_DL_STAGE" "$C1_DEST"
  fi
  ;;
 *) printf 'FAIL nonsecret C1 transfer allowlist; STOP\n' >&2; exit 1;;
esac
```

Use this exact transfer block to upload C1-inputs.json (set the box's
C1_INPUTS_FILE to that derived proof path), download C1-client-check.txt before
owner approval, upload agent.json before SQL audit (C1_AGENT_RECEIPT on box),
download C1-audit.json before human revoke, and download C1-fence.txt and C1-finish.json before
reporting. Upload client-withdraw.json after the runner exits (after the human revoke), before finish; upload agent-final.json after the same runner completes, before finish; after report/cleanup, upload C1.json and C1-cleanup.txt for W6 close.
The immutable box C1.json, bound by W7's `w6_window_id` with that W6's close-result.json, is W7's C1 input; ai-w7-preflight measures its digest.
This allowlist excludes private authorize/callback/key/token/session files.

```sh
# step: ai-w6-client-check
# readonly: no
# host: HezLead box root, W6 read-only SQL; before owner approval
set -euo pipefail
test "$WINDOW" = W6
C1_INPUTS_FILE=${C1_INPUTS_FILE:-$PROOF_DIR/C1-inputs.json}
test "$C1_INPUTS_FILE" = "$PROOF_DIR/C1-inputs.json" || { printf 'FAIL ai-w6-client-check: C1_INPUTS_FILE expected the box proof copy got other; STOP\n' >&2; exit 1; }
test -f "$PROOF_DIR/C1-client-verification.txt" || { printf 'FAIL ai-w6-client-check: C1-client-verification.txt expected present got missing; STOP\n' >&2; exit 1; }
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(readlink -f /home/commonswarm/oauth/current)" = "/home/commonswarm/oauth/releases/$RELEASE_SHA"
test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
test "$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')" = 0
python3 - "$C1_INPUTS_FILE" "$PROOF_DIR/client-check.sql" <<'PY'
import json,pathlib,re,sys
c=json.load(open(sys.argv[1])); v=c['verification_version']; h=c['metadata_digest']; owner=c['owner_user_id']; ws=c['smoke_workspace_id']; name=c['smoke_workspace_name'].replace("'","''")
assert type(v) is int and v>0 and re.fullmatch('[0-9a-f]{64}',h)
for value in [owner,ws]: assert re.fullmatch(r'[0-9a-fA-F-]{36}',value)
sql="SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json' AND verification_version="+str(v)+" AND metadata_digest='"+h+"' AND active AND withdrawn_at IS NULL AND registration_source='cimd' AND application_type='web' AND redirect_uris=ARRAY['https://commonswarm.com/oauth/c1-smoke/callback']::text[] AND scope_ceiling=ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[] AND full_account_eligible AND NOT delegation_eligible AND pkce_s256_tested AND dpop_tested AND redirect_tested AND origin_control_verified) AND EXISTS(SELECT 1 FROM swarm.memberships WHERE user_id='"+owner+"'::uuid AND workspace_id='"+ws+"'::uuid AND role='owner' AND revoked_at IS NULL) AND EXISTS(SELECT 1 FROM swarm.workspaces WHERE workspace_id='"+ws+"'::uuid AND name='"+name+"');\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
test "$(ai_ro -Atq --file /proof/client-check.sql)" = t
printf 'PASS exact C1 version/canonical digest/reviewed ceiling and smoke workspace owner\n' >"$PROOF_DIR/C1-client-check.txt"
```

```sh
# step: ai-w6-owner-client-command
# readonly: no
# host: HezLead Mac owner file-store CLI session; approve or withdraw only
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${INPUTS_FILE:?}" "${C1_INPUTS_FILE:?}" "${C1_PROOF_DIR:?}" "${C1_CLIENT_ACTION:?approve or withdraw}"
case "$C1_CLIENT_ACTION" in approve|withdraw) ;; *) exit 1;; esac
# Execute ai-w6-preflight and retain box C1-client-check.txt first.
# approve: only after ai-w6-start/ai-w6-pointer, immediately before consent.
# withdraw: AFTER ai-w6-fence-driver (human revoke + refused follow-up) and the runner's exit, in this same W6;
# withdrawal itself fences every family of this owner/client/version, so it never precedes the human revoke.
if test "$C1_CLIENT_ACTION" = approve; then test -f /Users/yulanbot/work/dcr-rt/c1-smoke.pointer; fi
test -f "$C1_PROOF_DIR/C1-client-check.txt"
node --import tsx --input-type=module - "$C1_INPUTS_FILE" "$C1_PROOF_DIR" "$C1_CLIENT_ACTION" <<'JS'
import { readFile, writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { credentialStore } from './src/cloud/storage.ts';
import { refreshedCredential } from './src/cloud/auth.ts';
import { cloudTarget, commandEndpoint, CLIENT_PROTOCOL_VERSION } from './src/cloud/config.ts';
import { withClientBuild } from './src/cloud/client-build.ts';
import { canonicalAdminJson } from './src/protocol/admin-policy.ts';
import { createHash } from 'node:crypto';
const [file,proof,action]=process.argv.slice(2);
try {
 const c=JSON.parse(await readFile(file,'utf8'));
 const t=JSON.parse(await readFile(c.target_file,'utf8')); if(t.url!=='https://api.commonswarm.com') throw Error();
 const target=cloudTarget(t.url,t.anonKey);
 const response=await fetch('https://commonswarm.com/oauth/c1-smoke/client.json',{redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok || response.headers.get('content-type')?.split(';')[0]!=='application/json') throw Error();
 const bytes=await response.text(); if(Buffer.byteLength(bytes)>4096) throw Error();
 const doc=JSON.parse(bytes);
 const digest=createHash('sha256').update(canonicalAdminJson(doc)).digest('hex');
 if(digest!==c.metadata_digest || doc.client_id!=='https://commonswarm.com/oauth/c1-smoke/client.json') throw Error();
 const store=await credentialStore({target,stateDirectory:c.state_directory,forceFile:true,warn:()=>{}});
 const human=await refreshedCredential(target,store); if(human.userId!==c.owner_user_id) throw Error();
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const idPath=`${proof}/${action}-request-id`; const receiptPath=`${proof}/client-${action}.json`;
 let commandId=null;
 try {
  const st=await lstat(idPath);
  if(st.isSymbolicLink() || !st.isFile()) { console.error('FAIL owner client command; saved request ID expected regular-non-symlink got other; STOP'); process.exit(1); }
  commandId=(await readFile(idPath,'utf8')).trim();
  if(!uuid.test(commandId)) { console.error('FAIL owner client command; saved request ID expected uuid got other; STOP'); process.exit(1); }
 } catch(e) { if(!e || e.code!=='ENOENT') throw e; }
 try {
  const rst=await lstat(receiptPath);
  if(rst.isSymbolicLink() || !rst.isFile()) { console.error('FAIL owner client command; retained receipt expected regular-non-symlink got other; STOP'); process.exit(1); }
  const raw=await readFile(receiptPath,'utf8');
  let existing=null, complete=false;
  try { existing=JSON.parse(raw); complete=!!raw.trim(); }
  catch { existing=null; complete=false; }
  if(complete && existing && existing.status==='PASS' && commandId && existing.command_id===commandId && existing.client_id===doc.client_id && existing.verification_version===c.verification_version && existing.metadata_digest===digest && existing.release_sha===c.release_sha && existing.window_id===c.window_id && existing.plan_sha256===c.plan_sha256 && existing.owner_user_id===c.owner_user_id && existing.action===action) {
   console.log('PASS owner client command; canonical document/version bound; reused completed receipt; no credentials emitted');
   process.exit(0);
  }
  if(complete) { console.error('FAIL owner client command; retained receipt expected matching-pass-for-this-action got mismatch; STOP'); process.exit(1); }
  // Incomplete/partial receipt: do not block reconciliation; resend the saved id.
 } catch(e) { if(!e || e.code!=='ENOENT') throw e; }
 if(!commandId){ commandId=randomUUID(); await writeFile(idPath,commandId+'\n',{flag:'wx',mode:0o600}); }
 const command={kind:action==='approve'?'approve_admin_client':'withdraw_admin_client_approval',client_id:doc.client_id,verification_version:c.verification_version,...(action==='withdraw'?{reason_code:'smoke_cleanup'}:{})};
 const r=await fetch(commandEndpoint(target),{method:'POST',headers:{authorization:`Bearer ${human.accessToken}`,apikey:target.anonKey,'content-type':'application/json'},body:JSON.stringify(withClientBuild({command_id:commandId,client_version:CLIENT_PROTOCOL_VERSION,stream:{kind:'account'},resource:'https://api.commonswarm.com/admin',command})),signal:AbortSignal.timeout(15000)});
 const result=await r.json(); if(!r.ok || result.status!=='accepted') throw Error();
 const receipt={status:'PASS',command_id:commandId,client_id:doc.client_id,verification_version:c.verification_version,metadata_digest:digest,release_sha:c.release_sha,window_id:c.window_id,plan_sha256:c.plan_sha256,owner_user_id:c.owner_user_id,action,...(action==='approve'?{approval_at:new Date().toISOString()}:{withdrawn_at:new Date().toISOString()})};
 const stagePath=`${receiptPath}.${commandId}.tmp`;
 try { await unlink(stagePath); } catch(e) { if(!e || e.code!=='ENOENT') throw e; }
 await writeFile(stagePath,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
 await rename(stagePath,receiptPath);
 console.log('PASS owner client command; canonical document/version bound; no credentials emitted');
} catch { console.error('FAIL owner client command; outcome may be unknown; reconcile saved request ID; STOP'); process.exitCode=1; }
JS
```

```sh
# step: ai-w6-start
# readonly: no
# host: HezLead Mac, after preflight/client-check; owner approval follows pointer publication; no browser launch
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${C1_PROOF_DIR:?}"
test -f "$C1_PROOF_DIR/C1-client-check.txt"
# Start runner and publish handoff before approving; approval is immediately before consent.
test -f /Users/yulanbot/work/BROWSER-READY
C1_SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$C1_SECRET_STAGE"
printf '%s\n' "$C1_SECRET_STAGE" >"$C1_PROOF_DIR/secret-stage.path"
node scripts/admin-smoke.mjs \
 --authorize-url-file "$C1_SECRET_STAGE/authorize.url" \
 --callback-file "$C1_SECRET_STAGE/callback.url" \
 --receipt-file "$C1_SECRET_STAGE/agent.json" \
 --verify-fenced --fence-file "$C1_SECRET_STAGE/fenced" \
 >"$C1_SECRET_STAGE/agent-status.log" 2>&1 &
C1_RUNNER_PID=$!
C1_POINTER=/Users/yulanbot/work/dcr-rt/c1-smoke.pointer
printf '%s\n' "$C1_RUNNER_PID" >"$C1_PROOF_DIR/runner.pid"
```

```sh
# step: ai-w6-pointer
# readonly: no
# host: HezLead Mac; runner underway, before owner approval/consent
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${C1_INPUTS_FILE:?}"
# F10: the stage and pointer are recorded by ai-w6-start; a later shell derives them from C1_PROOF_DIR.
C1_SECRET_STAGE=${C1_SECRET_STAGE:-$(cat "${C1_PROOF_DIR:?}/secret-stage.path")}
C1_POINTER=${C1_POINTER:-/Users/yulanbot/work/dcr-rt/c1-smoke.pointer}
node scripts/admin-smoke.mjs --dry-run >"$C1_SECRET_STAGE/request-plan.json"
python3 - "$C1_SECRET_STAGE" "$C1_POINTER" "$C1_INPUTS_FILE" "$INPUTS_FILE" docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md <<'PY'
import datetime,json,os,pathlib,re,sys
stage,pointer,cfile,inputs,spec=map(pathlib.Path,sys.argv[1:])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(stage)) and stage.is_dir() and not stage.is_symlink() and stage.resolve()==stage and stage.stat().st_mode & 0o777==0o700
assert str(pointer)=='/Users/yulanbot/work/dcr-rt/c1-smoke.pointer' and pointer.parent.resolve()==pointer.parent
if pointer.exists() or pointer.is_symlink():
    raise SystemExit('FAIL ai-w6-pointer: smoke pointer expected absent got present; an earlier W6 left it: run ai-w6-secret-close with that window\'s C1_PROOF_DIR, then retry; STOP')
c=json.loads(cfile.read_text()); d=json.loads(inputs.read_text()); request=json.loads((stage/'request-plan.json').read_text())
assert request['client_id']=='https://commonswarm.com/oauth/c1-smoke/client.json' and request['resource']=='https://api.commonswarm.com/admin'
scopes=[v for v in request['scope'].split() if v not in ('openid','offline_access')]
assert scopes and len(scopes)==len(set(scopes)) and all(re.fullmatch('[a-z]+:[a-z]+',v) and v in spec.read_text() for v in scopes)
name=c['smoke_workspace_name']
assert isinstance(name,str) and 0<len(name)<=200 and not any(ord(x)<32 for x in name)
assert not re.search(r'(?i)bearer|https?://|eyJ[A-Za-z0-9_-]+\.|(?:token|secret|password)=',name), 'FAIL secret-shaped pointer value; STOP'
expiry=datetime.datetime.fromisoformat(d['window_end_utc'].replace('Z','+00:00'))
assert expiry>datetime.datetime.now(datetime.timezone.utc)
r={'authorize_url_file':str(stage/'authorize.url'),'callback_file':str(stage/'callback.url'),
   'consent_choices':{'workspace_name':name,'scopes':scopes,'home':False,'full_account':False},
   'expires_at':d['window_end_utc']}
fd=os.open(pointer,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as output: output.write(json.dumps(r,sort_keys=True)+'\n')
print('PASS nonsecret D8 pointer: private absolute paths, exact consent choices, UTC expiry')
PY
```

```sh
# step: ai-w6-agent-receipt
# readonly: no
# host: HezLead Mac; export only redacted receipt from runner secret directory
set -euo pipefail
: "${C1_PROOF_DIR:?}"
C1_SECRET_STAGE=${C1_SECRET_STAGE:-$(cat "$C1_PROOF_DIR/secret-stage.path")}
python3 - "$C1_SECRET_STAGE/agent.json" "$C1_PROOF_DIR/agent.json" <<'PY'
import json,pathlib,re,sys
source,out=map(pathlib.Path,sys.argv[1:]); r=json.loads(source.read_text())
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}/agent.json',str(source)) and not source.is_symlink()
assert re.fullmatch('[0-9a-f]{16}',r['run_id'])
# These are the runner's nonsecret evidence fields; no claims, headers, URLs or tokens.
keys=['ok','run_id','workspace','steps','refused_after_fence','failed_step','failure_code']
public={k:r[k] for k in keys}
assert not re.search(r'(?i)access_token|refresh_token|code_verifier|authorization|eyJ[A-Za-z0-9_-]+\.',json.dumps(public)), 'FAIL private receipt data; STOP'
assert not out.is_symlink()
# The first export (fence window) may be replaced by the final one after the runner exits.
out.write_text(json.dumps(public)+'\n'); out.chmod(0o600)
if r['ok'] is True:
    final=out.parent/'agent-final.json'; assert not final.exists() and not final.is_symlink()
    final.write_text(json.dumps(public)+'\n'); final.chmod(0o600)
PY
```

HezLead's browser worker reads the pointer, waits for the 0600 authorize file,
refuses an expired pointer, follows consent_choices exactly (granular: workspace, scopes and home=false, full_account=false),
then atomically writes the full callback URL as 0600 to
the secret callback path without logging it. This is a separate browser-worker
assignment; this plan never launches the installed Chrome app. HezLead starts
the following box steps as soon as the agent reports
`agent_steps_complete_awaiting_human_fence`; the access token must remain live.
The box locates the smoke grant by the saved run-specific command ID, not a
most-recent-grant guess. Copy only agent.json (redacted command IDs) to the box.

```sh
# step: ai-w6-audit
# readonly: no
# host: HezLead box root; READ-ONLY SQL, smoke grant/family only
set -euo pipefail
C1_AGENT_RECEIPT=${C1_AGENT_RECEIPT:-$PROOF_DIR/agent.json}
C1_INPUTS_FILE=${C1_INPUTS_FILE:-$PROOF_DIR/C1-inputs.json}
test "$C1_AGENT_RECEIPT" = "$PROOF_DIR/agent.json" || { printf 'FAIL ai-w6-audit: C1_AGENT_RECEIPT expected the box proof copy got other; STOP\n' >&2; exit 1; }
test "$C1_INPUTS_FILE" = "$PROOF_DIR/C1-inputs.json" || { printf 'FAIL ai-w6-audit: C1_INPUTS_FILE expected the box proof copy got other; STOP\n' >&2; exit 1; }
python3 - "$C1_AGENT_RECEIPT" "$C1_INPUTS_FILE" "$PROOF_DIR/c1-audit.sql" <<'PY'
import json,pathlib,re,sys
r=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2])); run=r['run_id']; owner=c['owner_user_id']
assert re.fullmatch('[0-9a-f]{16}',run) and re.fullmatch(r'[0-9a-fA-F-]{36}',owner)
assert r['steps']['read_metadata_after_refresh']['result']=='pass'
command='c1_'+run+'_create_workspace'
assert r['steps']['create_workspace']['command_id']==command
# Audit has no client_id column: bind client through the durable grant row.
base="SELECT DISTINCT a.admin_grant_id,a.provider_grant_id FROM commonswarm_oauth.admin_oauth_audit a JOIN commonswarm_oauth.admin_grant_bindings b USING(admin_grant_id,provider_grant_id) WHERE a.owner_user_id='"+owner+"'::uuid AND a.request_id='"+command+"' AND b.client_id='https://commonswarm.com/oauth/c1-smoke/client.json'"
sql="BEGIN READ ONLY; SELECT count(*)=1 AS c1_one FROM ("+base+") s \\gset\n\\if :c1_one\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'ambiguous smoke binding'; END $$;\n\\endif\n"
sql+="WITH smoke AS ("+base+") SELECT json_build_object('grant_id',s.admin_grant_id,'provider_grant_id',s.provider_grant_id,'audit_counts',(SELECT json_object_agg(k.kind,k.n) FROM (SELECT kinds.kind,count(a.audit_id) AS n FROM (VALUES ('init'),('list'),('read'),('action')) kinds(kind) LEFT JOIN commonswarm_oauth.admin_oauth_audit a ON a.admin_grant_id=s.admin_grant_id AND a.provider_grant_id=s.provider_grant_id AND a.event_kind=kinds.kind AND a.outcome='committed' GROUP BY kinds.kind) k)) FROM smoke s; COMMIT;\n"
pathlib.Path(sys.argv[3]).write_text(sql)
PY
C1_AUDIT_STAGE=$(mktemp "$PROOF_DIR/C1-audit.json.XXXXXX") || { printf 'FAIL ai-w6-audit: audit staging file expected created got failure; STOP\n' >&2; exit 1; }
case "$C1_AUDIT_STAGE" in "$PROOF_DIR"/C1-audit.json.*) ;; *) printf 'FAIL ai-w6-audit: audit staging path expected under PROOF_DIR got other; STOP\n' >&2; exit 1;; esac
chmod 0600 "$C1_AUDIT_STAGE" || { rm -- "$C1_AUDIT_STAGE"; printf 'FAIL ai-w6-audit: audit staging mode expected 0600 got failure; STOP\n' >&2; exit 1; }
if ! ai_ro -Atq --file /proof/c1-audit.sql >"$C1_AUDIT_STAGE"; then
 rm -- "$C1_AUDIT_STAGE"
 printf 'FAIL ai-w6-audit: smoke audit query expected success got failure; STOP\n' >&2; exit 1
fi
python3 - "$C1_AUDIT_STAGE" <<'PY' || { rm -- "$C1_AUDIT_STAGE"; printf 'FAIL ai-w6-audit: audit counts expected four committed kinds got other; STOP\n' >&2; exit 1; }
import json,sys
r=json.load(open(sys.argv[1])); assert set(r['audit_counts'])=={'init','list','read','action'} and all(type(n) is int and n>0 for n in r['audit_counts'].values())
PY
mv -f "$C1_AUDIT_STAGE" "$PROOF_DIR/C1-audit.json"
```

The fence window is short: after its post-refresh read the runner waits at most
240 s (and at most until its 300 s access token is 20 s from expiry) for the
fence file. Inside that window the following steps run in order, driven by
ONE Mac step (ai-w6-fence-driver) that runs the reviewed blocks verbatim from the
verified plan bytes: ai-w6-agent-receipt, upload of agent.json, the box audit
(after upload completes, the Mac driver dispatches ai-w6-audit through the
existing box root shell's stdin; the box never waits for an input file), download of C1-audit.json, and ai-w6-human-revoke.
The runner prints its actual nonsecret fence cutoff (`fence_cutoff_epoch_ms`,
the minimum of its fence wait, token expiry and total deadline) just before its
ready line. The driver's absolute deadline is that cutoff less 5 s, never a
fresh interval from when the driver noticed the line; it refuses normal
revocation when the runner has exited or the cutoff has passed. Every ssh/scp
call is bounded by what remains, a stalled session included; with less than
45 s left it does NOT revoke. Inside ai-w6-human-revoke both owner credential
refreshes (the preflight and the CLI's own) and the revoke request run under one
alarm at the revoke cutoff (deadline less 20 s): no revoke is dispatched after
it, and a timeout leaves the outcome unknown, never C1 proof. After the window
only `C1_RECOVERY_REVOKE=1` runs, as cleanup recorded in
human-revoke-recovery.json, never as C1 refusal proof. In ai-w6-human-revoke the human revoke verb fences the grant,
then the fence file is written and the runner proves the refused follow-up. The owner's approval withdrawal comes
AFTER the runner exits: withdrawal itself fences every family of that
owner/client/version (guard_owner_approval), so it must not precede the human
revoke it is meant to follow. Report order: approval_at <= revoked_at <=
withdrawn_at.

```sh
# step: ai-w6-fence-driver
# readonly: no
# host: HezLead Mac shell of ai-w6-start, after the owner approval; runs the fence-window blocks verbatim; nothing else may use the owner session meanwhile
set -euo pipefail
: "${PLAN_FILE:?}" "${INPUTS_FILE:?}" "${C1_PROOF_DIR:?}" "${C1_INPUTS_FILE:?}"
C1_SECRET_STAGE=$(cat "$C1_PROOF_DIR/secret-stage.path") || { printf 'FAIL ai-w6-fence-driver: secret-stage.path expected readable got failure; STOP\n' >&2; exit 1; }
C1_RUNNER_PID=$(cat "$C1_PROOF_DIR/runner.pid") || { printf 'FAIL ai-w6-fence-driver: runner.pid expected readable got failure; STOP\n' >&2; exit 1; }
C1_POINTER=/Users/yulanbot/work/dcr-rt/c1-smoke.pointer
RELEASE_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_sha"])' "$INPUTS_FILE")
WINDOW_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$INPUTS_FILE")
C1_BOX_PROOF=/home/commonswarm/admin-issuance/release-proofs/${RELEASE_SHA}-W6-${WINDOW_ID}
# The deadline comes from the RUNNER's own nonsecret fence cutoff (min of its fence wait, token expiry and total
# deadline), printed with its ready line, less 5 s; never from when this driver noticed the line. A budget
# (at most 220 s from that moment) may only shorten it (tests). Every transport below and in ai-w6-transfer is
# bounded by what remains.
test "${C1_RECOVERY_REVOKE:-0}" != 1 || { printf 'FAIL ai-w6-fence-driver: C1_RECOVERY_REVOKE expected unset in the fence window got 1; STOP\n' >&2; exit 1; }
C1_FENCE_BUDGET=${C1_FENCE_BUDGET_SECONDS:-220}
[[ "$C1_FENCE_BUDGET" =~ ^[1-9][0-9]{0,2}$ ]] && test "$C1_FENCE_BUDGET" -le 220 || { printf 'FAIL ai-w6-fence-driver: fence budget expected 1-220 s got other; STOP\n' >&2; exit 1; }
fence_block() {
 python3 -c '
import hashlib,json,os,re,stat,sys
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b"".join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get("plan_sha256"):
        raise SystemExit("FAIL "+step+": PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got "+("missing-or-not-regular" if raw is None else "digest-mismatch")+"; STOP")
    return raw
blocks=re.findall(r"^`{3}sh\n(.*?)^`{3}$",verified_plan(sys.argv[1],sys.argv[3],"ai-w6-fence-driver").decode(),re.M|re.S)
found=[b for b in blocks if b.startswith("# step: "+sys.argv[2]+"\n")]
if len(found)!=1: raise SystemExit("FAIL ai-w6-fence-driver: block "+sys.argv[2]+" expected one got other; STOP")
sys.stdout.write(found[0])
' "$PLAN_FILE" "$1" "$INPUTS_FILE"
}
# Each block runs in its own bash process, so its own set -e holds (no errexit-ignoring context).
export PLAN_FILE INPUTS_FILE C1_PROOF_DIR C1_INPUTS_FILE C1_SECRET_STAGE C1_RUNNER_PID C1_POINTER RELEASE_SHA WINDOW_ID
fence_run() {
 local FENCE_SOURCE
 FENCE_SOURCE=$(fence_block "$1") || return 1
 /bin/bash -c "$FENCE_SOURCE" || { printf 'FAIL ai-w6-fence-driver: %s expected PASS got failure; STOP\n' "$1" >&2; return 1; }
}
# Wait for the runner's fence-ready line; consent may take up to 25 minutes.
until grep -qx 'agent_steps_complete_awaiting_human_fence' "$C1_SECRET_STAGE/agent-status.log" 2>/dev/null; do
 kill -0 "$C1_RUNNER_PID" 2>/dev/null || { printf 'FAIL ai-w6-fence-driver: runner expected awaiting fence got exited; STOP\n' >&2; exit 1; }
 sleep 1
done
FENCE_START=$(date +%s)
C1_RUNNER_CUTOFF_MS=$(grep -E '^fence_cutoff_epoch_ms=[0-9]{13}$' "$C1_SECRET_STAGE/agent-status.log" 2>/dev/null) || { printf 'FAIL ai-w6-fence-driver: runner fence cutoff expected printed got missing; normal revoke refused; STOP\n' >&2; exit 1; }
test "$(printf '%s\n' "$C1_RUNNER_CUTOFF_MS" | wc -l | tr -d ' ')" = 1 || { printf 'FAIL ai-w6-fence-driver: runner fence cutoff expected one line got several; STOP\n' >&2; exit 1; }
C1_FENCE_DEADLINE=$(( ${C1_RUNNER_CUTOFF_MS#fence_cutoff_epoch_ms=} / 1000 - 5 ))
test "$C1_FENCE_DEADLINE" -le "$(( FENCE_START + C1_FENCE_BUDGET ))" || C1_FENCE_DEADLINE=$(( FENCE_START + C1_FENCE_BUDGET ))
export C1_FENCE_DEADLINE
kill -0 "$C1_RUNNER_PID" 2>/dev/null || { printf 'FAIL ai-w6-fence-driver: runner expected alive at the fence got exited; normal revoke refused; STOP\n' >&2; exit 1; }
test "$C1_FENCE_DEADLINE" -gt "$FENCE_START" || { printf 'FAIL ai-w6-fence-driver: runner fence cutoff expected ahead got passed; normal revoke refused; run ai-emergency-close, then a recovery revoke; STOP\n' >&2; exit 1; }
fence_run ai-w6-agent-receipt || exit 1
export C1_TRANSFER_DIRECTION=upload C1_TRANSFER_FILE=agent.json
fence_run ai-w6-transfer || exit 1
# Descriptor 9 is the existing persistent B shell's stdin, held open on M before W6.
# Dispatch only after upload completed; B runs once and never polls for its input.
: "${C1_BOX_STDIN_FD:?FAIL ai-w6-fence-driver: existing box shell stdin descriptor expected set got unset; STOP}"
test "$C1_BOX_STDIN_FD" = 9 || { printf 'FAIL ai-w6-fence-driver: box shell stdin descriptor expected 9 got other; STOP\n' >&2; exit 1; }
FENCE_LEFT=$(( C1_FENCE_DEADLINE - $(date +%s) ))
test "$FENCE_LEFT" -gt 0 || { printf 'FAIL ai-w6-fence-driver: audit dispatch expected before fence deadline got expired; STOP\n' >&2; exit 1; }
C1_AUDIT_DISPATCH='set -euo pipefail; test -f "$PROOF_DIR/agent.json"; test ! -L "$PROOF_DIR/agent.json"; C1_AGENT_RECEIPT="$PROOF_DIR/agent.json"; ai_run ai-w6-audit'
export C1_AUDIT_DISPATCH
perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "$FENCE_LEFT" /bin/bash -c 'printf "%s\n" "$C1_AUDIT_DISPATCH" >&9' || { printf 'FAIL ai-w6-fence-driver: dispatch to existing box shell expected sent got failure; STOP\n' >&2; exit 1; }
printf -v FENCE_PROBE 'sudo -n test -s %q' "$C1_BOX_PROOF/C1-audit.json"
while :; do
 FENCE_LEFT=$(( C1_FENCE_DEADLINE - $(date +%s) ))
 test "$FENCE_LEFT" -gt 0 || { printf 'FAIL ai-w6-fence-driver: box C1-audit.json expected before the fence deadline got none; STOP\n' >&2; exit 1; }
 test "$(( $(date +%s) - FENCE_START ))" -lt 150 || { printf 'FAIL ai-w6-fence-driver: box C1-audit.json expected within 150 s got none; STOP\n' >&2; exit 1; }
 if perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "$FENCE_LEFT" ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ops@100.115.66.74 "$FENCE_PROBE"; then break; fi
 sleep 1
done
export C1_TRANSFER_DIRECTION=download C1_TRANSFER_FILE=C1-audit.json
fence_run ai-w6-transfer || exit 1
unset C1_TRANSFER_DIRECTION C1_TRANSFER_FILE
# The revoke needs live-token budget left for the runner's refused follow-up; otherwise do not revoke here.
FENCE_LEFT=$(( C1_FENCE_DEADLINE - $(date +%s) ))
kill -0 "$C1_RUNNER_PID" 2>/dev/null || { printf 'FAIL ai-w6-fence-driver: runner expected alive before the human revoke got exited; revoke NOT attempted; STOP\n' >&2; exit 1; }
test "$FENCE_LEFT" -ge 45 || { printf 'FAIL ai-w6-fence-driver: fence budget before the human revoke expected at-least-45-s got %s s; revoke NOT attempted; run ai-emergency-close, then the human revoke as recovery; STOP\n' "$FENCE_LEFT" >&2; exit 1; }
fence_run ai-w6-human-revoke || exit 1
FENCE_SECONDS=$(( $(date +%s) - FENCE_START ))
printf '%s\n' "$FENCE_SECONDS" >"$C1_PROOF_DIR/fence-seconds.txt"
printf 'PASS ai-w6-fence-driver: fence chain completed in %s s (runner budget 240 s)\n' "$FENCE_SECONDS"
```


```sh
# step: ai-w6-human-revoke
# readonly: no
# host: HezLead Mac, OWNER's file-store CLI session; human revoke verb D6
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
: "${C1_PROOF_DIR:?}" "${C1_INPUTS_FILE:?}"
C1_SECRET_STAGE=${C1_SECRET_STAGE:-$(cat "$C1_PROOF_DIR/secret-stage.path")}
C1_RUNNER_PID=${C1_RUNNER_PID:-$(cat "$C1_PROOF_DIR/runner.pid")}
# The human revoke verb fences this grant/family FIRST; the approval withdrawal follows after the runner exits.
test ! -e "$C1_PROOF_DIR/client-withdraw.json" || { printf 'FAIL ai-w6-human-revoke: client-withdraw.json expected absent-before-revoke got present; STOP\n' >&2; exit 1; }
# Normal revoke only inside the fence window ai-w6-fence-driver sets (C1_FENCE_DEADLINE). After it, only a labelled
# cleanup revoke (C1_RECOVERY_REVOKE=1), recorded as human-revoke-recovery.json and never as C1 refusal proof.
if test "${C1_RECOVERY_REVOKE:-0}" = 1; then
 # The recovery flag ALWAYS selects cleanup, even with a retained deadline: never the receipt or the fence file.
 unset C1_FENCE_DEADLINE
 C1_REVOKE_OUT=$C1_PROOF_DIR/human-revoke-recovery.json
elif test -z "${C1_FENCE_DEADLINE:-}"; then
 printf 'FAIL ai-w6-human-revoke: C1_FENCE_DEADLINE expected set-by-ai-w6-fence-driver got unset; for cleanup after the window set C1_RECOVERY_REVOKE=1 (never C1 proof); STOP\n' >&2; exit 1
else
 [[ "$C1_FENCE_DEADLINE" =~ ^[0-9]{10}$ ]] || { printf 'FAIL ai-w6-human-revoke: C1_FENCE_DEADLINE expected epoch-seconds got other; STOP\n' >&2; exit 1; }
 C1_REVOKE_OUT=$C1_PROOF_DIR/human-revoke.json
fi
# Inside the fence window both owner refreshes and the revoke request run under one alarm at the revoke cutoff (20 s
# before the fence deadline): no refresh can outlast it, and the revoke can be dispatched only before it.
c1_revoke_bounded() {
 if test -n "${C1_FENCE_DEADLINE:-}"; then
  C1_LEFT=$(( C1_FENCE_DEADLINE - 20 - $(date +%s) ))
  test "$C1_LEFT" -gt 0 || { printf 'FAIL ai-w6-human-revoke: revoke cutoff (fence deadline - 20 s) expected ahead got passed; revoke NOT dispatched; STOP\n' >&2; return 1; }
  perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "$C1_LEFT" "$@"
 else
  "$@"
 fi
}
# The nonsecret C1-audit.json from the box is in C1_PROOF_DIR (ai-w6-fence-driver downloads it).
C1_GRANT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["grant_id"])' "$C1_PROOF_DIR/C1-audit.json")
C1_ID_FILE=$C1_PROOF_DIR/revoke-request-id
if test -L "$C1_ID_FILE"; then
 printf 'FAIL ai-w6-human-revoke: revoke-request-id expected regular-non-symlink got symlink; STOP\n' >&2; exit 1
fi
if test -e "$C1_ID_FILE"; then
 test -f "$C1_ID_FILE" || { printf 'FAIL ai-w6-human-revoke: revoke-request-id expected regular-non-symlink got other; STOP\n' >&2; exit 1; }
 C1_REVOKE_REQUEST_ID=$(python3 -c 'import pathlib,re,sys
t=pathlib.Path(sys.argv[1]).read_text().strip()
assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", t, re.I)
print(t)' "$C1_ID_FILE") || { printf 'FAIL ai-w6-human-revoke: saved request ID expected uuid got other; STOP\n' >&2; exit 1; }
else
 C1_REVOKE_REQUEST_ID=$(node -e 'console.log(require("node:crypto").randomUUID())')
 ( set -C; printf '%s\n' "$C1_REVOKE_REQUEST_ID" >"$C1_ID_FILE" )
fi
C1_REVOKE_DONE=0
for C1_EXISTING in "$C1_PROOF_DIR/human-revoke.json" "$C1_PROOF_DIR/human-revoke-recovery.json"; do
 if test -L "$C1_EXISTING"; then
  printf 'FAIL ai-w6-human-revoke: retained revoke receipt expected regular-non-symlink got symlink; STOP\n' >&2; exit 1
 fi
 if test -f "$C1_EXISTING"; then
  C1_REVOKE_RECEIPT_STATE=$(python3 - "$C1_EXISTING" "$C1_REVOKE_REQUEST_ID" "$C1_GRANT_ID" <<'PY' || { printf 'FAIL ai-w6-human-revoke: retained revoke receipt expected revoked-for-this-grant-and-saved-id got mismatch; STOP\n' >&2; exit 1; }
import json,sys
raw=open(sys.argv[1],'rb').read()
if not raw.strip():
    print('incomplete'); raise SystemExit(0)
try: r=json.loads(raw)
except ValueError:
    print('incomplete'); raise SystemExit(0)
if not isinstance(r,dict):
    print('incomplete'); raise SystemExit(0)
# Complete evidence must bind this grant and the saved request id; missing either is a mismatch.
if r.get('state')=='revoked' and r.get('grant_id')==sys.argv[3] and r.get('request_id')==sys.argv[2]:
    print('match'); raise SystemExit(0)
raise SystemExit(1)
PY
)
  if test "$C1_REVOKE_RECEIPT_STATE" = match; then
   C1_REVOKE_DONE=1
   break
  fi
  # Incomplete/partial: do not block; resend the saved id after reconciliation shows it did not commit.
 fi
done
if test "$C1_REVOKE_DONE" = 1 && test -f "$C1_PROOF_DIR/human-revoke.json"; then
 C1_REVOKE_LEFTOVER=$C1_PROOF_DIR/human-revoke-recovery.json
 if test -L "$C1_REVOKE_LEFTOVER"; then
  printf 'FAIL ai-w6-human-revoke: leftover recovery receipt expected regular-non-symlink got symlink; STOP\n' >&2; exit 1
 fi
 if test -e "$C1_REVOKE_LEFTOVER"; then
  python3 - "$C1_REVOKE_LEFTOVER" "$C1_PROOF_DIR" <<'PY' || { printf 'FAIL ai-w6-human-revoke: leftover incomplete recovery receipt expected moved-aside got failure; STOP\n' >&2; exit 1; }
import os,stat,sys
src,proof=sys.argv[1],sys.argv[2]
inc=os.path.join(proof,'incomplete')
if os.path.lexists(inc):
    st=os.lstat(inc)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode)!=0o700:
        raise SystemExit('FAIL ai-w6-human-revoke: incomplete/ expected 0700-directory got other; STOP')
else:
    os.mkdir(inc,0o700)
os.chmod(inc,0o700)
dst=os.path.join(inc,'human-revoke-recovery.json')
if os.path.lexists(dst):
    raise SystemExit('FAIL ai-w6-human-revoke: incomplete/human-revoke-recovery.json expected absent got present; STOP')
os.rename(src,dst)
reason=os.path.join(inc,'reason.txt')
fd=os.open(reason,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
    os.write(fd,b'completed human-revoke.json already matches grant and saved request id; partial human-revoke-recovery.json was not parsed\n')
finally:
    os.close(fd)
print('PASS ai-w6-human-revoke: leftover incomplete recovery receipt moved aside')
PY
 fi
fi
if test "$C1_REVOKE_DONE" != 1; then
c1_revoke_bounded node --import tsx --input-type=module - "$C1_INPUTS_FILE" <<'JS' || { printf 'FAIL ai-w6-human-revoke: owner preflight expected verified-before-the-revoke-cutoff got failure-or-timeout; revoke NOT dispatched; STOP\n' >&2; exit 1; }
import { readFile } from 'node:fs/promises';
import { credentialStore,defaultCredentialStateDirectory } from './src/cloud/storage.ts';
import { cloudTarget } from './src/cloud/config.ts';
import { refreshedCredential } from './src/cloud/auth.ts';
import { readCurrentTarget } from './src/cloud/current-target.ts';
try {
 const c=JSON.parse(await readFile(process.argv[2],'utf8')); const t=await readCurrentTarget();
 if(t?.url!=='https://api.commonswarm.com' || c.state_directory!==defaultCredentialStateDirectory()) throw Error();
 const store=await credentialStore({target:t,forceFile:true,warn:()=>{}}); const human=await refreshedCredential(t,store);
 if(human.userId!==c.owner_user_id) throw Error();
} catch { console.error('FAIL owner CLI target/session mismatch; STOP'); process.exitCode=1; }
JS
C1_REVOKE_STAGE=$(mktemp "$C1_PROOF_DIR/.$(basename "$C1_REVOKE_OUT").XXXXXX") || { printf 'FAIL ai-w6-human-revoke: revoke staging file expected created got failure; STOP\n' >&2; exit 1; }
if ! c1_revoke_bounded node --import tsx src/cli.ts admin revoke --grant-id "$C1_GRANT_ID" \
 --request-id "$C1_REVOKE_REQUEST_ID" --force-file-store --json \
 >"$C1_REVOKE_STAGE" 2>"$C1_PROOF_DIR/human-revoke-status.log"; then
  rm -- "$C1_REVOKE_STAGE"
  printf 'FAIL ai-w6-human-revoke: revoke expected confirmed-before-the-revoke-cutoff got failure-or-timeout; outcome unknown; reconcile request ID %s; a later revoke is recovery only, never C1 proof; STOP\n' "$C1_REVOKE_REQUEST_ID" >&2; exit 1
 fi
 python3 - "$C1_REVOKE_STAGE" "$C1_REVOKE_REQUEST_ID" "$C1_GRANT_ID" <<'PY' || { rm -- "$C1_REVOKE_STAGE"; printf 'FAIL ai-w6-human-revoke: revoke receipt expected revoked-for-this-grant-and-saved-id got other; STOP\n' >&2; exit 1; }
import json,sys
r=json.load(open(sys.argv[1]))
assert r.get('state')=='revoked' and r.get('grant_id')==sys.argv[3] and r.get('request_id')==sys.argv[2]
PY
 mv -f "$C1_REVOKE_STAGE" "$C1_REVOKE_OUT"
 C1_REVOKE_DONE=1
fi
if test "${C1_RECOVERY_REVOKE:-0}" = 1; then
 if test -f "$C1_REVOKE_OUT"; then
  python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["state"]=="revoked" and r.get("grant_id")==sys.argv[2] and r.get("request_id")==sys.argv[3]' "$C1_REVOKE_OUT" "$C1_GRANT_ID" "$C1_REVOKE_REQUEST_ID" || { printf 'FAIL ai-w6-human-revoke: recovery revoke expected revoked-for-this-grant-and-saved-id got other; STOP\n' >&2; exit 1; }
 fi
 printf 'RECOVERY ai-w6-human-revoke: grant revoked after the fence window; human-revoke-recovery.json is cleanup, NOT C1 refusal proof\n'
else
python3 - "$C1_PROOF_DIR/human-revoke.json" "$C1_PROOF_DIR/agent.json" "$C1_SECRET_STAGE/fenced" <<'PY'
import datetime,json,os,pathlib,sys
r=json.load(open(sys.argv[1])); assert r['state']=='revoked'
r['revoked_at']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
pathlib.Path(sys.argv[1]).write_text(json.dumps(r)+'\n')
a=json.load(open(sys.argv[2])); p=pathlib.Path(sys.argv[3]); assert not p.exists() and not p.is_symlink()
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: f.write(a['run_id']+'\n')
PY
# Same runner performs --verify-fenced with a still-live token. Never restart it. Its exit is awaited by
# polling (this step may run in a child shell of ai-w6-fence-driver), bounded by the runner's own deadline.
C1_WAIT_START=$(date +%s)
while kill -0 "$C1_RUNNER_PID" 2>/dev/null; do
 test "$(( $(date +%s) - C1_WAIT_START ))" -lt 330 || { printf 'FAIL ai-w6-human-revoke: runner exit expected within 330 s got still-running; STOP\n' >&2; exit 1; }
 sleep 1
done
python3 - "$C1_SECRET_STAGE/agent.json" <<'PY' || { printf 'FAIL ai-w6-human-revoke: runner receipt expected ok-with-refused-follow-up got other; STOP\n' >&2; exit 1; }
import json,sys
r=json.load(open(sys.argv[1])); assert r['ok'] is True and r['refused_after_fence']['http_status'] in (401,403)
PY
fi
# Execute ai-w6-agent-receipt again after the runner exits, before the withdrawal and the final report.
```

```sh
# step: ai-w6-fence-readback
# readonly: no
# host: HezLead box root; read-only DB fence proof, grant/family from C1 audit only
set -euo pipefail
python3 - "$PROOF_DIR/C1-audit.json" "$PROOF_DIR/c1-fence.sql" <<'PY'
import json,pathlib,re,sys
r=json.load(open(sys.argv[1])); g=r['grant_id']; family=r['provider_grant_id']
assert re.fullmatch(r'[0-9a-fA-F-]{36}',g) and isinstance(family,str) and 0<len(family)<=2048
quoted="'"+family.replace("'","''")+"'"
sql="SELECT g.state='revoked' AND b.state='revoked' AND t.grant_id IS NOT NULL FROM swarm.admin_grants g JOIN commonswarm_oauth.admin_grant_bindings b ON b.admin_grant_id=g.grant_id LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=b.provider_grant_id WHERE g.grant_id='"+g+"'::uuid AND b.provider_grant_id="+quoted+";\n"
pathlib.Path(sys.argv[2]).write_text(sql)
PY
test "$(ai_ro -Atq --file /proof/c1-fence.sql)" = t
printf 'PASS grant revoked and refresh family tombstoned; live follow-up refusal recorded by runner\n' >"$PROOF_DIR/C1-fence.txt"
```

After the fence and the runner's exit, execute ai-w6-owner-client-command with
`C1_CLIENT_ACTION=withdraw`; upload its redacted receipt and download C1-fence.txt to the
Mac proof directory. Do not edit the runner receipt to invent human results.
The receipt below combines independently observed audit, human and agent proof.
The workspace remains **`c1-smoke-<runid> (test, archive me)`**, accepted residue
(D4), with a 10-second `/app` archive step on Tom's morning list. No archive is
claimed. W7/W5b follow-up: a separately reviewed site release removes
`site/public/oauth/c1-smoke/client.json` (or returns 404); verify public absence
and keep the callback free of secrets. Never leave a long-lived approved client.

```sh
# step: ai-w6-report
# readonly: no
# host: HezLead Mac; redacted report and machine receipt
unset NODE_OPTIONS ADMIN_SMOKE_TEST_TRANSPORT ADMIN_SMOKE_FIXTURE_ORIGIN ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS ADMIN_SMOKE_SECRET_ROOT # production node: no inherited preload or test-transport input
set -euo pipefail
node --input-type=module - "$C1_PROOF_DIR" "$INPUTS_FILE" <<'JS'
import { readFile,writeFile } from 'node:fs/promises';
const [root,input]=process.argv.slice(2);
try {
 if(!(await readFile(`${root}/C1-cleanup.txt`,'utf8')).startsWith('PASS')) throw Error();
 const d=JSON.parse(await readFile(input,'utf8'));
 const a=JSON.parse(await readFile(`${root}/agent.json`,'utf8'));
 const audit=JSON.parse(await readFile(`${root}/C1-audit.json`,'utf8'));
 const revoke=JSON.parse(await readFile(`${root}/human-revoke.json`,'utf8'));
 const approval=JSON.parse(await readFile(`${root}/client-approve.json`,'utf8'));
 const finish=JSON.parse(await readFile(`${root}/C1-finish.json`,'utf8'));
 const withdrawal=JSON.parse(await readFile(`${root}/client-withdraw.json`,'utf8'));
 const fence=await readFile(`${root}/C1-fence.txt`,'utf8');
 if(!a.ok || a.refused_after_fence?.refusal_code==null || ![401,403].includes(a.refused_after_fence.http_status) || revoke.state!=='revoked' || withdrawal.status!=='PASS' || !fence.startsWith('PASS') || !a.workspace.accepted_residue || !Object.values(audit.audit_counts).every(n=>Number.isSafeInteger(n)&&n>0)) throw Error();
 if(!approval.approval_at || !withdrawal.withdrawn_at || !revoke.revoked_at || !(Date.parse(approval.approval_at)<=Date.parse(revoke.revoked_at) && Date.parse(revoke.revoked_at)<=Date.parse(withdrawal.withdrawn_at))) throw Error();
 if(finish.state!==(d.keep_open===true?'open':'closed') || finish.explicit_keep_open!==(d.keep_open===true)) throw Error();
 const r={approval_at:approval.approval_at,withdrawn_at:withdrawal.withdrawn_at,revoked_at:revoke.revoked_at,refused_follow_up:a.refused_after_fence,final_gate:finish.state,release_sha:d.release_sha,status:'PASS',cleanup:true,audit_kinds:['init','list','read','action'],audit_counts:audit.audit_counts,grant_revoked:true,refresh_family_tombstoned:true,live_access_refused:true,client_approval_withdrawn:true,accepted_residue:a.workspace.name,approval_scope:'account-wide owner/client/version',site_document_removal:'W7/W5b next reviewed site release'};
 await writeFile(`${root}/C1.json`,JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});
 const text=`# C1 smoke\n\nRelease: ${d.release_sha}\n\nPASS hosted consent, PKCE/DPoP, init/list/read/action, create workspace/seat, revoke seat, refresh, human revoke, live access refusal and approval withdrawal.\n\nApproval scope: account-wide owner/client/version. Approval at ${approval.approval_at}; revoked at ${revoke.revoked_at}; withdrawn at ${withdrawal.withdrawn_at}.\n\nRefused follow-up: HTTP ${a.refused_after_fence.http_status}, ${a.refused_after_fence.refusal_code}. Final gate: ${finish.state}.\n\nAudit counts: ${JSON.stringify(audit.audit_counts)}\n\nAccepted residue: ${a.workspace.name}. Tom: archive in /app.\n\nRefresh family tombstone measured; no post-revoke refresh request was made.\n\nFollow-up W7/W5b: next site release removes oauth/c1-smoke/client.json and verifies 404.\n`;
 await writeFile(`${root}/C1-SMOKE-REPORT.md`,text,{flag:'wx',mode:0o600});
} catch { console.error('FAIL C1 report evidence incomplete; STOP'); process.exitCode=1; }
JS
```

```sh
# step: ai-w6-secret-close
# readonly: no
# host: HezLead Mac; success or stopped runner, guarded private cleanup
set -euo pipefail
: "${C1_PROOF_DIR:?}"
C1_SECRET_STAGE=${C1_SECRET_STAGE:-$(cat "$C1_PROOF_DIR/secret-stage.path")}
C1_RUNNER_PID=${C1_RUNNER_PID:-$(cat "$C1_PROOF_DIR/runner.pid")}
C1_POINTER=${C1_POINTER:-/Users/yulanbot/work/dcr-rt/c1-smoke.pointer}
if kill -0 "$C1_RUNNER_PID" 2>/dev/null; then printf 'FAIL runner still active; STOP before cleanup\n' >&2; exit 1; fi
python3 - "$C1_SECRET_STAGE" "$C1_POINTER" "$C1_PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pointer=pathlib.Path(sys.argv[2]); saved=pathlib.Path(sys.argv[3])
assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) and p.is_dir() and not p.is_symlink() and p.resolve()==p and p.stat().st_mode & 0o777==0o700
assert saved.read_text().strip()==str(p)
assert str(pointer)=='/Users/yulanbot/work/dcr-rt/c1-smoke.pointer' and not pointer.is_symlink()
if pointer.exists():
    assert pointer.is_file() and pointer.stat().st_mode & 0o777==0o600
    r=__import__('json').loads(pointer.read_text()); assert r['authorize_url_file']==str(p/'authorize.url') and r['callback_file']==str(p/'callback.url')
PY
rm -r -- "$C1_SECRET_STAGE" || { printf 'FAIL cleanup refused %s; STOP\n' "$C1_SECRET_STAGE" >&2; exit 1; }
if test -e "$C1_POINTER"; then
 rm -- "$C1_POINTER" || { printf 'FAIL cleanup refused %s; STOP\n' "$C1_POINTER" >&2; exit 1; }
fi
printf 'PASS private handoffs removed; redacted receipts and accepted residue retained\n' >"$C1_PROOF_DIR/C1-cleanup.txt"
```

```sh
# step: ai-w6-closed-gate-probe
# readonly: probe
# host: HezLead box root; outside public gate after the W6 default deactivation (called by ai-w6-finish)
set -euo pipefail
python3 - <<'PY'
import json,urllib.request
for method in ('GET','HEAD'):
    req=urllib.request.Request('https://mcp.commonswarm.com/admin/gate',method=method,headers={'Origin':'https://commonswarm.com','User-Agent':'curl/8.7.1'})
    with urllib.request.urlopen(req,timeout=15) as response:
        body=response.read(4097)
        assert response.status==200 and response.headers.get('Access-Control-Allow-Origin')=='*' and 'no-store' in response.headers.get('Cache-Control','')
        assert (json.loads(body)=={'state':'closed'}) if method=='GET' else body==b''
print('PASS W6 default deactivation: public GET/HEAD gate CLOSED')
PY
```

```sh
# step: ai-w6-finish
# readonly: no
# host: HezLead box root; after the human revoke, the refused follow-up and the approval withdrawal
# Own subshell: the EXIT trap re-arms the timer BEFORE control returns to the window shell and ai-close.
(
# HezLead ruling: every exit re-arms the recycle timer W6 has held since ai-w6-activation-apply.
C1_CLOSED_CONFIRMED=0
C1_BLOCK_DONE=0
w6_finish_exit() {
 local status=$?
 trap - EXIT
 if test "$status" = 0 && test "${C1_BLOCK_DONE:-0}" != 1; then status=2; fi
 if test -z "${EDGE_RECYCLE_TIMER:-}"; then
  test "$status" = 0 || printf 'FAIL ai-w6-finish: recycle timer name unknown at exit; re-arm it by hand with ai-w4-timer-recovery; STOP\n' >&2
 elif ! systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"; then
  systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-finish: recycle timer start expected success got failure; STOP\n' >&2; test "$status" != 0 || status=3; }
  systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-finish: recycle timer expected active got inactive; STOP\n' >&2; test "$status" != 0 || status=3; }
 fi
 # Status contract (first statement of the block): 1 only after a confirmed CLOSED readback; anything else UNKNOWN.
 if test "$status" = 1 && test "${C1_CLOSED_CONFIRMED:-0}" != 1; then status=2; fi
 exit "$status"
}
trap w6_finish_exit EXIT
set -euo pipefail
test "$WINDOW" = W6 || { printf 'FAIL ai-w6-finish: window expected W6 got other; STOP\n' >&2; exit 2; }
ai_run ai-inputs
test -f "$PROOF_DIR/C1-fence.txt" || { printf 'FAIL ai-w6-finish: C1-fence.txt expected present got missing; STOP\n' >&2; exit 1; }
test -f "$PROOF_DIR/client-withdraw.json" || { printf 'FAIL ai-w6-finish: client-withdraw.json expected present got missing; STOP\n' >&2; exit 1; }
test ! -e "$PROOF_DIR/edge-measurement-final.json" || { printf 'FAIL ai-w6-finish: edge-measurement-final.json expected absent got present; STOP\n' >&2; exit 1; }
python3 - "$PROOF_DIR/agent-final.json" "$PROOF_DIR/client-withdraw.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1])); w=json.load(open(sys.argv[2]))
assert r['ok'] is True and r['refused_after_fence']['http_status'] in (401,403) and r['refused_after_fence']['refusal_code'], 'FAIL actual refused follow-up; STOP'
assert w['status']=='PASS' and w['withdrawn_at'], 'FAIL approval withdrawal; STOP'
PY
EDGE_MEASUREMENT_OUT=$PROOF_DIR/edge-measurement-final.json
if test "$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("keep_open",False) else "0")' "$INPUTS_FILE")" = 1; then
 # Keep open: the remeasure closes, measures and reopens ONLY through the measured path; on failure this
 # step reports the remeasure's own result (1 confirmed CLOSED, otherwise UNKNOWN).
 ( ai_run ai-edge-remeasure ) || { W6_REMEASURE_STATUS=$? W6_REMEASURE_CALLER=ai-w6-finish; printf 'FAIL ai-w6-finish: keep-open remeasure expected measured-and-reopened got failure; STOP\n' >&2; if test "$W6_REMEASURE_STATUS" = 1; then C1_CLOSED_CONFIRMED=1; printf 'FAIL %s: issuance CLOSED (remeasure failure close confirmed by readback); STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 1; fi; printf 'FAIL %s: issuance state UNKNOWN after the remeasure failure (may be OPEN); run ai-emergency-close; STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 2; }
 W6_FINAL_STATE=$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-w6-finish: cutover state query expected success got failure; STOP\n' >&2; exit 1; }
 test "$W6_FINAL_STATE" = t || { printf 'FAIL ai-w6-finish: keep-open state expected open-and-measured got other; STOP\n' >&2; exit 1; }
 ai_run ai-w6-activation-probes
 printf '{"state":"open","explicit_keep_open":true}\n' >"$PROOF_DIR/C1-finish.json"
else
 ai_run ai-w6-activation-rollback
 # The closed state is measured too, so W7 opens on a fresh receipt; hold the timer for the hook pair.
 systemctl stop "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w6-finish: recycle timer stop expected success got failure; STOP\n' >&2; exit 1; }
 ( ai_run ai-edge-remeasure ) || { W6_REMEASURE_STATUS=$? W6_REMEASURE_CALLER=ai-w6-finish; printf 'FAIL ai-w6-finish: closed-state remeasure expected measured got failure; STOP\n' >&2; if test "$W6_REMEASURE_STATUS" = 1; then C1_CLOSED_CONFIRMED=1; printf 'FAIL %s: issuance CLOSED (remeasure failure close confirmed by readback); STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 1; fi; printf 'FAIL %s: issuance state UNKNOWN after the remeasure failure (may be OPEN); run ai-emergency-close; STOP\n' "$W6_REMEASURE_CALLER" >&2; exit 2; }
 W6_FINAL_STATE=$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-w6-finish: cutover state query expected success got failure; STOP\n' >&2; exit 1; }
 test "$W6_FINAL_STATE" = t || { printf 'FAIL ai-w6-finish: default state expected closed-and-measured got other; STOP\n' >&2; exit 1; }
 ai_run ai-w6-closed-gate-probe
 printf '{"state":"closed","explicit_keep_open":false}\n' >"$PROOF_DIR/C1-finish.json"
fi
unset EDGE_MEASUREMENT_OUT
printf 'PASS ai-w6-finish: final state recorded; edge-measurement-final.json is W7 EDGE_MEASUREMENT_FILE; recycle timer re-armed on exit\n'
# Reached only by running to the end: an early exit (an expansion error can leave $? at 0) is never success.
C1_BLOCK_DONE=1
)
```


## W7: separately approved retirement proof

Lane 5 already removes runtime mint/admission/callback in the release build,
and W4 performs the separately approved terminal DB fence before W6. W7 preserves the measured OPEN/CLOSED state left by W6 and must
never be interpreted as allowing legacy authentication until smoke is done.
Its job is final retirement attestation after C1; no DROP of history or reserve
rollback. Historical rows remain for human recovery. No optional v1 delegation.


```sh
# step: ai-w7-timer-hold
# readonly: no
# host: box root; source in the persistent W7 shell; holds the recycle timer through proof and close
set -euo pipefail
test "$WINDOW" = W7
: "${EDGE_RECYCLE_TIMER:?}" "${EDGE_RECYCLE_SERVICE:?}"
ai_w7_timer_restore() {
 local status=$?
 trap - EXIT INT TERM
 if test -z "${EDGE_RECYCLE_TIMER:-}"; then
  printf 'FAIL ai-w7-timer-hold: recycle timer name unknown at restore; re-arm with ai-w4-timer-recovery; STOP\n' >&2
  test "$status" != 0 || status=1
 elif ! systemctl is-active --quiet "$EDGE_RECYCLE_TIMER"; then
  systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w7-timer-hold: recycle timer restore expected success got failure; STOP\n' >&2; test "$status" != 0 || status=1; }
  systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w7-timer-hold: recycle timer expected active after restore got inactive; STOP\n' >&2; test "$status" != 0 || status=1; }
 fi
 return "$status"
}
trap 'ai_w7_timer_restore; exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
systemctl stop "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-w7-timer-hold: recycle timer stop expected success got failure; STOP\n' >&2; exit 1; }
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" && { printf 'FAIL ai-w7-timer-hold: recycle timer expected inactive after stop got active; STOP\n' >&2; exit 1; }
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive || { printf 'FAIL ai-w7-timer-hold: recycle service expected inactive after timer stop got other; STOP\n' >&2; exit 1; }
printf 'PASS ai-w7-timer-hold: recycle timer held inactive through W7 proof and close; restore runs on every exit and before recording close\n'
```

```sh
# step: ai-w7-recovery
# readonly: no
# host: HezLead box root; W7 recovery preserves W6 measured OPEN/CLOSED state; never activation rollback
set -euo pipefail
# W7 preserves the measured OPEN/CLOSED state left by W6 and must
# never be interpreted as allowing legacy authentication until smoke is done.
test "$WINDOW" = W7
: "${INPUTS_FILE:?}" "${PROOF_DIR:?}"
python3 - "$INPUTS_FILE" "$PROOF_DIR" <<'PY' || { printf 'FAIL ai-w7-recovery: W6 measured OPEN/CLOSED state expected preserved got other; STOP\n' >&2; exit 1; }
import json,os,pathlib,re,stat,sys
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w7-recovery: '+what+' expected '+expected+' got '+got+'; STOP')
def read(path):
    try: fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError: return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        return os.read(fd,1048577)
    finally: os.close(fd)
d=json.load(open(sys.argv[1])); proof=pathlib.Path(sys.argv[2]); sha=d.get('release_sha'); wid=d.get('w6_window_id')
need(d.get('window')=='W7' and isinstance(wid,str) and re.fullmatch('[A-Za-z0-9]{6}',wid) is not None,'w6_window_id','six-alphanumeric','other')
w=pathlib.Path('/home/commonswarm/admin-issuance/release-proofs/'+sha+'-W6-'+wid)
need(w.is_dir() and not w.is_symlink(),'W6 proof directory','directory','missing-or-symlink')
finish=read(w/'C1-finish.json'); measure=read(w/'edge-measurement-final.json')
need(None not in (finish,measure),'W6 C1-finish.json/edge-measurement-final.json','regular-files','missing-or-not-regular')
f=json.loads(finish); m=json.loads(measure)
need(f.get('state') in ('open','closed') and isinstance(f.get('explicit_keep_open'),bool),'W6 finish state','open-or-closed','other')
need(m.get('release_sha')==sha and type(m.get('generation')) is int and m.get('invalidated_at') is None,'W6 final measurement','this-release-not-invalidated','other')
# Latest valid receipt: ai-open retains the validated opening bytes as edge-measurement-open.json.
opening=read(proof/'edge-measurement-open.json')
if opening is None:
    gen=m['generation']
else:
    om=json.loads(opening)
    need(om.get('release_sha')==sha and type(om.get('generation')) is int and om.get('invalidated_at') is None,'W7 opening measurement','this-release-not-invalidated','other')
    need(om['generation']>=m['generation'],'W7 opening generation','>=W6-final','stale-'+str(om['generation']))
    gen=om['generation']
pathlib.Path(sys.argv[2],'W7-recovery-expected.json').write_text(json.dumps({
    'release_sha':sha,'w6_window_id':wid,'keep_open':f['explicit_keep_open'],'state':f['state'],
    'generation':gen,'invalidated_at':None},sort_keys=True)+'\n')
print(f['explicit_keep_open'] and 'open' or 'closed')
PY
W7_EXPECTED_KEEP=$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1]))["keep_open"] else "0")' "$PROOF_DIR/W7-recovery-expected.json") || { printf 'FAIL ai-w7-recovery: expected keep_open readable got failure; STOP\n' >&2; exit 1; }
W7_EXPECTED_GEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$PROOF_DIR/W7-recovery-expected.json") || { printf 'FAIL ai-w7-recovery: expected generation readable got failure; STOP\n' >&2; exit 1; }
if test "$W7_EXPECTED_KEEP" = 1; then
 W7_LIVE=$(ai_ro -Atq --command "SELECT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation AND release_generation=${W7_EXPECTED_GEN} FROM commonswarm_oauth.admin_cutover_state WHERE singleton;") || { printf 'FAIL ai-w7-recovery: keep-open state query expected success got failure; STOP\n' >&2; exit 1; }
 test "$W7_LIVE" = t || { printf 'FAIL ai-w7-recovery: keep-open issuance expected preserved-open-at-expected-generation got other; STOP\n' >&2; exit 1; }
else
 W7_LIVE=$(ai_ro -Atq --command "SELECT NOT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation AND release_generation=${W7_EXPECTED_GEN} FROM commonswarm_oauth.admin_cutover_state WHERE singleton;") || { printf 'FAIL ai-w7-recovery: closed-state query expected success got failure; STOP\n' >&2; exit 1; }
 test "$W7_LIVE" = t || { printf 'FAIL ai-w7-recovery: closed issuance expected preserved-closed-at-expected-generation got other; STOP\n' >&2; exit 1; }
fi
ai_run ai-w4-timer-recovery || { printf 'FAIL ai-w7-recovery: recycle timer restore expected success got failure; STOP\n' >&2; exit 1; }
printf 'PASS ai-w7-recovery: W6 measured OPEN/CLOSED state preserved; generation unchanged; recycle timer active; no activation rollback\n' >"$PROOF_DIR/W7-recovery.txt"
```

```sh
# step: ai-w7-approval
# readonly: yes
# host: Mac or box; before any W7 operation
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); a=d.get('approval')
assert d.get('window')=='W7' and isinstance(a,dict), 'FAIL W7 explicit retirement approval required; STOP'
assert a.get('action')=='retire-legacy-admin-mint' and a.get('approver') in ('Tom','HezLead') and a.get('prompt_ref'), 'FAIL W7 approval identity; STOP'
assert all(a.get(k)==d.get(k) and isinstance(d.get(k),str) and d[k] for k in ('release_sha','window_id','plan_sha256')), 'FAIL W7 approval binding; STOP'
print('W7 retirement approval present; C1 and unreachable proof remain required')
PY
```

```sh
# step: ai-w7-preflight
# readonly: yes
# host: box root; no mutation; binds the W6 of this release named by w6_window_id and prints the C1 report binding
set -euo pipefail
: "${INPUTS_FILE:?}"
python3 - "$INPUTS_FILE" "${GATE_RECEIPT_FILE-}" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
def need(ok,what,expected,got):
    if not ok: raise SystemExit('FAIL ai-w7-preflight: '+what+' expected '+expected+' got '+got+'; STOP')
def read(path):
    try: fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except OSError: return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        return os.read(fd,1048577)
    finally: os.close(fd)
d=json.load(open(sys.argv[1])); sha=d.get('release_sha'); wid=d.get('w6_window_id')
need(d.get('window')=='W7' and isinstance(wid,str) and re.fullmatch('[A-Za-z0-9]{6}',wid) is not None,'W7 w6_window_id','six-alphanumeric-window-id','missing-or-other')
w=pathlib.Path('/home/commonswarm/admin-issuance/release-proofs/'+sha+'-W6-'+wid)
need(w.is_dir() and not w.is_symlink() and w.resolve()==w,'W6 proof directory','directory','missing-or-symlink')
i=read(w/'inputs.json'); closed=read(w/'closed.txt'); record=read(w/'close-result.json'); report=read(w/'C1.json')
need(None not in (i,closed,record,report),'W6 inputs.json/closed.txt/close-result.json/C1.json','regular-files','missing-or-not-regular')
i=json.loads(i)
need(i.get('window')=='W6' and i.get('release_sha')==sha and i.get('window_id')==wid,'W6 inputs.json binding','W6-same-release-and-id','mismatch')
r=json.loads(record)
need(record==(json.dumps(r,sort_keys=True)+'\n').encode() and set(r)=={'release_sha','window','window_id','result','closed_at'},'W6 close-result.json','exact-sorted-record','other')
need(r['release_sha']==sha and r['window']=='W6' and r['window_id']==wid and r['result']=='success' and (r['closed_at']+'\n').encode()==closed,'W6 close result','success-at-closed.txt','other')
c=json.loads(report)
need(c.get('release_sha')==sha and c.get('status')=='PASS' and c.get('cleanup') is True,'W6 C1.json release/status/cleanup','this-release-PASS-cleanup','other')
need(c.get('audit_kinds')==['init','list','read','action'] and c.get('grant_revoked') is True and c.get('refresh_family_tombstoned') is True and c.get('live_access_refused') is True and c.get('client_approval_withdrawn') is True,'W6 C1.json evidence','complete','incomplete')
digest=hashlib.sha256(report).hexdigest()
binding={'w6_window_id':wid,'c1_report':str(w/'C1.json'),'c1_report_sha256':digest,'final_gate':c.get('final_gate')}
if sys.argv[2]:
    try: receipt=json.load(open(sys.argv[2]))
    except (OSError,ValueError): receipt=None
    need(isinstance(receipt,dict) and receipt.get('release_sha')==sha,'gate receipt release_sha','input-release-sha','missing-or-mismatch')
    smoke=(receipt.get('gates') or {}).get('admin-c1-smoke') if isinstance(receipt.get('gates'),dict) else None
    need(isinstance(smoke,dict) and smoke.get('sha256')==digest,'W6 C1.json digest vs admin-c1-smoke gate','identical','mismatch')
    binding['admin_c1_smoke_sha256']=smoke.get('sha256')
print(json.dumps(binding,sort_keys=True))
PY
```

```sh
# step: ai-w7-proof
# readonly: no
# host: box root; database read-only; Mac already ran ai-gates; box binds receipt digest and C1.json digest
set -euo pipefail
test "$WINDOW" = W7
ai_run ai-w7-approval
ai_run ai-gates-bind
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" && { printf 'FAIL ai-w7-proof: recycle timer expected held-inactive got active; STOP\n' >&2; exit 1; }
test "$(systemctl show -p ActiveState --value "$EDGE_RECYCLE_SERVICE")" = inactive || { printf 'FAIL ai-w7-proof: recycle service expected inactive while timer held got other; STOP\n' >&2; exit 1; }
W7_C1_BINDING=$(ai_run ai-w7-preflight) || { printf 'FAIL ai-w7-proof: W6 C1 binding expected valid got refused; STOP\n' >&2; exit 1; }
printf '%s\n' "$W7_C1_BINDING" >"$PROOF_DIR/c1-report-binding.json"
ai_deadline
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
test "$(ai_ro -Atq --command "SELECT legacy_closed AND legacy_fence_evidence_ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t
# Runtime wrapper removal is a build proof, paired with actual OAuth positive
# controls in legacy-admin-unreachable. Do not call a private mint to test it.
python3 - "$RELEASE_ROOT/supabase/functions/command/index.ts" <<'PY'
import pathlib,re,sys
s=pathlib.Path(sys.argv[1]).read_text()
assert not re.search(r'export\s+(?:async\s+)?function\s+handleAdminRuntimeCommand\b',s), 'FAIL runtime export survives; STOP'
PY
ai_ro -Atq --command 'SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;' >"$PROOF_DIR/retirement-gate-state.txt"
printf 'PASS W7 legacy runtime and DB auth permanently unreachable; history retained\n' >"$PROOF_DIR/retirement.txt"
```

W7/W5b site cleanup follow-up: make a separately reviewed commit removing
`site/public/oauth/c1-smoke/client.json`, release the resulting landed SHA with
the W5 site procedure, then retain a public 404 probe receipt. This plan never
removes a tracked file inside an immutable release or rebuilds an old SHA.

## Close and abort cleanup

Before a recovered W6 close, ai-w6-close-state measures the retained Mac
C1_PROOF_DIR. Its secret-stage.path is the start signal; the box session's
PROOF_DIR/secret-stage.path is unrelated. Upload C1-close-state.json even when
start never ran. The box records that there was nothing to clean in that case.
A dangling C1-client-check.txt symlink is present and refuses.

```sh
# step: ai-w6-close-state
# readonly: no
# host: HezLead Mac; recovered close only, after the runner has stopped
set -euo pipefail
: "${C1_PROOF_DIR:?}" "${INPUTS_FILE:?}"
python3 - "$C1_PROOF_DIR" "$INPUTS_FILE" <<'PY'
import json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); d=json.load(open(sys.argv[2]))
def refuse(what): raise SystemExit('FAIL ai-w6-close-state: '+what+'; STOP')
if d.get('window')!='W6' or not root.is_absolute() or not root.is_dir() or root.is_symlink(): refuse('C1_PROOF_DIR expected retained regular directory got other')
for name in ('secret-stage.path','runner.pid','C1-client-check.txt','C1-cleanup.txt'):
    path=root/name
    if os.path.lexists(path) and (not path.is_file() or path.is_symlink()): refuse(name+' expected regular-non-symlink got other')
started=os.path.lexists(root/'secret-stage.path')
if started:
    try:
        pid=int((root/'runner.pid').read_text().strip()); assert pid>1
        os.kill(pid,0)
    except ProcessLookupError: pass
    except (OSError,ValueError,AssertionError): refuse('runner expected proven stopped got unknown')
    else: refuse('runner expected stopped got active')
result={k:d[k] for k in ('release_sha','window_id','plan_sha256')}
result['started']=started
target=root/'C1-close-state.json'
if target.is_symlink(): refuse('C1-close-state.json expected not-symlink got symlink')
target.write_text(json.dumps(result,sort_keys=True)+'\n'); target.chmod(0o600)
print('PASS recovered W6 runner state measured')
PY
```


Before forward close run ai-ordinary-probes, the window's specific probes and
ai-live-controls phase after, with its bound CONSENT_RECEIPT_FILE. Before
recovered close use phase recovery. Supply
`CLOSE_RESULT=success|recovered` only after those proofs; it is an outcome input,
not permission to skip probes. Failed recovery cannot close. W6 refuses opening while browser readiness or activation/consent approval is absent.
Recovered W6 close requires emergency env/overlay/DB close and ordinary controls.
Recovered W7 preserves the measured OPEN/CLOSED state left by W6; it never runs
activation rollback, increments generation, removes activation env or recreates OAuth.
Recovered W4 runs ai-w4-rollback and ai-close recovered, preserving the permanent legacy closure.

```sh
# step: ai-close
# readonly: no
# host: box root; verified success/recovery only
set -euo pipefail
# W5 owns a companion site session, not an admin DB/secret session. Its recovered
# close consumes the uploaded companion proof and common ordinary controls only.
if test "$WINDOW" = W5 && test "$CLOSE_RESULT" = recovered; then
 : "${SITE_RECOVERY_EVIDENCE:?FAIL ai-close: recovered W5 site receipt directory expected set got unset; STOP}"
 python3 - "$INPUTS_FILE" "$SITE_RECOVERY_EVIDENCE" /srv/commonswarm/site <<'PY' || { printf 'FAIL ai-close: recovered W5 site close, recovery receipt and current expected closed-recovered-baseline got other; STOP\n' >&2; exit 1; }
import hashlib,json,pathlib,re,sys
d=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2]); site=pathlib.Path(sys.argv[3])
assert root.is_absolute() and root.is_dir() and not root.is_symlink()
def regular(name):
    path=root/name
    assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(root.resolve())
    return path
try:
    go=regular('GO.txt').read_text().splitlines()
    status=regular('deploy-status.txt').read_text().splitlines()
    assert go.count('SHA='+d['release_sha'])==1 and go.count('BASE_SHA='+d['baseline_site_sha'])==1
    assert go.count('HOLDS_RESOLVED=yes')==1
    deploy=[x for x in status if x.startswith('deploy_exit=')]
    assert len(deploy)==1 and re.fullmatch(r'deploy_exit=[0-9]+',deploy[0])
except (AssertionError,OSError):
    raise SystemExit('FAIL ai-close: recovered W5 deploy evidence expected GO.txt and site2-04 deploy-status.txt got absent or invalid; incident stays open; STOP')
rows=regular('CLOSE.txt').read_text().splitlines(); manifest=regular('manifest.json')
assert rows.count('CLOSED=yes')==1 and rows.count('PIN_RELEASED=yes')==1
outcomes=[x[8:] for x in rows if x.startswith('OUTCOME=')]
assert len(outcomes)==1 and outcomes[0] in ('rolled-back','failed-before-switch')
assert rows.count('MANIFEST_SHA256='+hashlib.sha256(manifest.read_bytes()).hexdigest())==1
bound=set()
for r in json.loads(manifest.read_text()):
    rel=pathlib.PurePosixPath(r['path']); assert not rel.is_absolute() and '..' not in rel.parts
    assert hashlib.sha256(regular(str(rel)).read_bytes()).hexdigest()==r['sha256']; bound.add(str(rel))
required={'previous.original','site2-07-pin-close.txt','GO.txt','deploy-status.txt'}
assert required<=bound
pin=regular('site2-07-pin-close.txt').read_text().splitlines()
assert 'pin_released=yes' in pin and 'OUTCOME='+outcomes[0] in pin
previous=regular('previous.original').read_text().strip()
assert previous==d['baseline_site_target']
assert re.fullmatch(re.escape(str(site))+r'/releases/[0-9]{8}T[0-9]{6}Z-'+re.escape(d['baseline_site_sha'][:12])+r'-[0-9a-f]{16}',previous)
assert (site/'current').resolve(strict=True)==pathlib.Path(previous) and pathlib.Path(previous,'app/index.html').is_file()
if outcomes[0]=='rolled-back':
    assert {'rollback-auto.txt','site2-06-rollback-verify.txt'}<=bound
    rollback=regular('rollback-auto.txt').read_text().splitlines()
    assert any(x.startswith('rollback_reason=') for x in rollback) and any(x.startswith('restored_release=') for x in rollback)
    assert 'ROLLBACK_PUBLIC_BYTES=PASS' in regular('site2-06-rollback-verify.txt').read_text().splitlines()
else:
    assert 'site2-04-reconciliation.txt' in bound
    receipt=regular('site2-04-reconciliation.txt').read_text().splitlines()
    assert 'DEPLOYMENT=failed-before-switch' in receipt and 'RETRY=forbidden' in receipt
PY

 test ! -e "$PROOF_DIR/closed.txt" && test ! -L "$PROOF_DIR/closed.txt"
 test ! -e "$PROOF_DIR/close-result.json" && test ! -L "$PROOF_DIR/close-result.json"
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-recovery.json" "$PROOF_DIR/consent-post-W5.json" "recovery" no ai-close <<'PY' || { printf 'FAIL ai-close: retained close receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY

 W5_RECOVERY_TIMER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["edge_recycle_timer"])' "$INPUTS_FILE")
 systemctl is-active --quiet "$W5_RECOVERY_TIMER" || { printf 'FAIL ai-close: recovered W5 recycle timer expected active got inactive; STOP\n' >&2; exit 1; }
 W5_RECOVERY_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
 python3 - "$INPUTS_FILE" "$W5_RECOVERY_TIME" "$PROOF_DIR/close-result.json" <<'PY'
import json,pathlib,sys
d=json.load(open(sys.argv[1])); assert d['window']=='W5'
pathlib.Path(sys.argv[3]).write_text(json.dumps({'release_sha':d['release_sha'],'window':'W5','window_id':d['window_id'],'result':'recovered','closed_at':sys.argv[2]},sort_keys=True)+'\n')
PY
 printf '%s\n' "$W5_RECOVERY_TIME" >"$PROOF_DIR/closed.txt"
 printf 'CLOSED-RECOVERED W5 site baseline restored and companion cleanup closed\n' >"$PROOF_DIR/W5-recovered.txt"
 printf 'PASS window closed recovered; CLOSED-RECOVERED W5; nonsecret proofs retained\n'
else
# W2: once probe-staged.txt exists, every close attempt revokes the DCR probe grant FIRST, before
# CLOSE_RESULT or any receipt is checked (a withheld CLOSE_RESULT still revokes); an unproven
# revoke STOPs the close.
if test "$WINDOW" = W2 && test -f "$PROOF_DIR/probe-staged.txt" && test ! -f "$PROOF_DIR/dcr-probe-revoked.json"; then
 if test -f "$PROOF_DIR/dcr-probe-revoke-attempted.txt"; then
  # A started revoke is never re-run. The close reports REVOKE-UNPROVEN and continues only with an
  # explicit HezLead ruling input, which it records; the window is never stuck open.
  w2_unproven_ruling() {
  python3 - "$PROOF_DIR" "$INPUTS_FILE" "${W2_REVOKE_UNPROVEN_ACCEPTED:-}" "$1" <<'PY'
import datetime,hashlib,json,os,pathlib,re,stat,sys
proof=pathlib.Path(sys.argv[1]); inputs=json.load(open(sys.argv[2])); ruling_path=sys.argv[3]; mode=sys.argv[4]
record=proof/'dcr-probe-revoke-unproven.json'
# The staged client_id comes from the nonsecret proof record, never from the secret file.
client=json.loads(record.read_text()).get('client_id') if record.exists() else None
if not record.exists() and mode=='check': record.write_text(json.dumps({'client_id':None,'revoked':False,'status':'REVOKE-UNPROVEN','reason':'a started revoke was not proven'},sort_keys=True)+'\n')
def refuse(what): raise SystemExit('REVOKE-UNPROVEN ai-close: DCR probe grant client_id '+str(client)+' is not proven revoked; ruling '+what+'; HezLead revokes it and supplies W2_REVOKE_UNPROVEN_ACCEPTED=<absolute ruling file> to close; STOP')
if not (isinstance(client,str) and client): refuse('cannot bind: no staged client_id recorded')
if not os.path.isabs(ruling_path): refuse('file expected absolute-path got missing')
try: fd=os.open(ruling_path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
except OSError: refuse('file expected regular-non-symlink got missing-or-symlink')
try:
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) not in (0o600,0o644): refuse('file expected regular-0600-or-0644 got other')
    # Read the COMPLETE file with an enforced bound: parse and hash exactly those bytes.
    chunks,size=[],0
    while True:
        chunk=os.read(fd,65537-size)
        if not chunk: break
        chunks.append(chunk); size+=len(chunk)
        if size>65536: refuse('file expected at-most-65536-bytes got larger')
finally: os.close(fd)
raw=b''.join(chunks)
try: r=json.loads(raw)
except ValueError: r=None
keys={'action','approver','release_sha','window_id','plan_sha256','client_id','at'}
if not (isinstance(r,dict) and set(r)==keys): refuse('keys expected exact-ruling-keys got other-set')
if r['action']!='accept-unproven-dcr-revoke': refuse('action expected accept-unproven-dcr-revoke got other')
if r['approver']!='HezLead': refuse('approver expected HezLead got other')
if r['release_sha']!=inputs['release_sha']: refuse('release_sha expected input-release-sha got mismatch')
if r['window_id']!=inputs['window_id']: refuse('window_id expected input-window-id got mismatch')
if r['plan_sha256']!=inputs['plan_sha256']: refuse('plan_sha256 expected input-plan-sha256 got mismatch')
if r['client_id']!=client: refuse('client_id expected staged-client-id got mismatch')
try: when=datetime.datetime.strptime(r['at'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc) if isinstance(r['at'],str) else None
except ValueError: when=None
if when is None or when>datetime.datetime.now(datetime.timezone.utc): refuse('at expected UTC-Z-not-future got other')
if mode=='final':
    # Final validation, before the stage is removed: print the exact acceptance payload; the shell
    # keeps it in memory and writes it just before closed.txt (no further read of the ruling file).
    sys.stdout.write(json.dumps({'status':'REVOKE-UNPROVEN-ACCEPTED','ruling':r,'ruling_sha256':hashlib.sha256(raw).hexdigest()},sort_keys=True))
else: print('REVOKE-UNPROVEN ruling for DCR probe grant client_id '+client+' in window '+r['window_id']+' validated; recorded only if the close succeeds')
PY
  }
  w2_unproven_ruling check
  W2_UNPROVEN_RULING=1
 else
  ai_run ai-w2-revoke-probes
 fi
fi
: "${CLOSE_RESULT:?}"
case "$CLOSE_RESULT" in success) test -f "$PROOF_DIR/ordinary-after.json";; recovered) test -f "$PROOF_DIR/ordinary-recovery.json";; *) exit 1;; esac
case "$CLOSE_RESULT" in success) CLOSE_PHASE=after;; *) CLOSE_PHASE=recovery;; esac
case "$WINDOW" in W1|W2|W2b|W3|W4) CONSENT_PHASE=pre-W1;; *) CONSENT_PHASE=post-W5;; esac
test -f "$PROOF_DIR/consent-$CONSENT_PHASE.json" || { printf 'FAIL ai-close: retained consent receipt expected consent-%s.json got missing; STOP\n' "$CONSENT_PHASE" >&2; exit 1; }
python3 - "$PLAN_FILE" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$PROOF_DIR" "$PROOF_DIR/ordinary-$CLOSE_PHASE.json" "$PROOF_DIR/consent-$CONSENT_PHASE.json" "$CLOSE_PHASE" no ai-close <<'PY' || { printf 'FAIL ai-close: retained close receipts expected valid got refused; STOP\n' >&2; exit 1; }
import hashlib,json,os,pathlib,re,stat,subprocess,sys
plan,inputs,archive,proof,live,consent,phase,retain,step=sys.argv[1:10]
def read_regular(name):
    try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except (OSError,TypeError,ValueError): return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): return None
        chunks=[]
        while True:
            chunk=os.read(fd,1048576)
            if not chunk: return b''.join(chunks)
            chunks.append(chunk)
    finally: os.close(fd)
def verified_plan(name,inputs,step):
    raw=read_regular(name) if os.path.isabs(name) else None
    if raw is None or hashlib.sha256(raw).hexdigest()!=json.load(open(inputs)).get('plan_sha256'):
        raise SystemExit('FAIL '+step+': PLAN_FILE expected absolute-regular-file-with-input-plan_sha256 got '+('missing-or-not-regular' if raw is None else 'digest-mismatch')+'; STOP')
    return raw
blocks=re.findall(r'^`{3}sh\n(.*?)^`{3}$',verified_plan(plan,inputs,step).decode(),re.M|re.S)
found=[b for b in blocks if b.startswith('# step: ai-live-controls\n')]
if len(found)!=1: raise SystemExit('FAIL '+step+': ai-live-controls block expected one got '+str(len(found))+'; STOP')
env=dict(os.environ,INPUTS_FILE=inputs,BOX_ARCHIVE_PATH=archive,PROOF_DIR=proof,LIVE_CONTROLS_FILE=live,CONSENT_RECEIPT_FILE=consent,LIVE_CONTROLS_EXPECT_PHASE=phase,LIVE_CONTROLS_RETAIN=retain)
raise SystemExit(subprocess.run(['/bin/bash'],input=found[0],text=True,env=env).returncode)
PY
if test "$CLOSE_RESULT" = success; then
 case "$WINDOW" in
  W1)
   BACKUP_GATE_DIR="$PROOF_DIR"
   ( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-close: W1: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
   unset BACKUP_GATE_DIR
   ;;
  W2)
   test -f "$PROOF_DIR/schema-committed.txt" || { printf 'FAIL ai-close: W2 schema-committed.txt expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/W2-probes.txt" || { printf 'FAIL ai-close: W2 W2-probes.txt expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/issuer-credential.txt" || { printf 'FAIL ai-close: W2 issuer-credential.txt expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/dcr-probe-revoked.json" || { printf 'FAIL ai-close: W2 dcr-probe-revoked.json expected present got missing; STOP\n' >&2; exit 1; };;
  W2b)
   BACKUP_GATE_DIR="$PROOF_DIR"
   ( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-close: W2b: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
   unset BACKUP_GATE_DIR
   test "$(cat "$PROOF_DIR/w2b-forward-catalogs.txt" 2>/dev/null)" = 'PASS W2b forward catalogs: all five true after the issuer credential' || { printf 'FAIL ai-close: W2b w2b-forward-catalogs.txt expected exact-PASS-line got missing-or-other; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/w2b-preconditions.txt" || { printf 'FAIL ai-close: W2b w2b-preconditions.txt expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/issuer-credential.txt" || { printf 'FAIL ai-close: W2b issuer-credential.txt expected present got missing; STOP\n' >&2; exit 1; };;
  W3) test -f "$PROOF_DIR/W3-probes.txt";;
  W4)
   BACKUP_GATE_DIR="$PROOF_DIR"
   ( ai_run ai-backup-gate-check ) >/dev/null || { printf 'FAIL ai-close: W4: backup-gate.json expected valid-bound-fresh-receipt got refused; STOP\n' >&2; exit 1; }
   unset BACKUP_GATE_DIR
   test -f "$PROOF_DIR/W4-readback.txt" || { printf 'FAIL ai-close: W4 W4-readback.txt expected present got missing; STOP\n' >&2; exit 1; };;
  W6)
   test -f "$PROOF_DIR/C1.json" || { printf 'FAIL ai-close: W6 C1.json expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/C1-cleanup.txt" || { printf 'FAIL ai-close: W6 C1-cleanup.txt expected present got missing; STOP\n' >&2; exit 1; }
   test -f "$PROOF_DIR/C1-finish.json" || { printf 'FAIL ai-close: W6 C1-finish.json expected present got missing; STOP\n' >&2; exit 1; };;
  W7) test -f "$PROOF_DIR/retirement.txt";;
  *) echo 'FAIL no implemented forward close for this window; STOP' >&2; exit 1;;
 esac
fi
if test "$WINDOW" = W6 && test "$CLOSE_RESULT" = recovered; then
 for C1_FILE in C1-client-check.txt C1-cleanup.txt C1-close-state.json C1.json C1-finish.json; do
  if test -e "$PROOF_DIR/$C1_FILE" || test -L "$PROOF_DIR/$C1_FILE"; then
   [ -f "$PROOF_DIR/$C1_FILE" ] && [ ! -L "$PROOF_DIR/$C1_FILE" ] || { printf 'FAIL ai-close: recovered W6 %s expected regular-non-symlink got other; STOP\n' "$C1_FILE" >&2; exit 1; }
  fi
 done
 C1_START_RAN=$(python3 - "$INPUTS_FILE" "$PROOF_DIR/C1-close-state.json" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
    assert set(r)=={'release_sha','window_id','plan_sha256','started'} and type(r['started']) is bool
    assert all(r[k]==d[k] for k in ('release_sha','window_id','plan_sha256'))
except (OSError,ValueError,AssertionError,KeyError,TypeError):
    raise SystemExit('FAIL ai-close: recovered W6 C1-close-state.json expected this-window Mac start-state receipt got missing-or-other; STOP') from None
print('1' if r['started'] else '0')
PY
 ) || exit 1
 if test "$C1_START_RAN" = 1; then
  [ -f "$PROOF_DIR/C1-cleanup.txt" ] && [ ! -L "$PROOF_DIR/C1-cleanup.txt" ] || { printf 'FAIL ai-close: recovered W6 C1-cleanup.txt expected regular-non-symlink after secret-stage.path in C1_PROOF_DIR got missing-or-other; run ai-w6-secret-close with C1_PROOF_DIR from this window and upload C1-cleanup.txt, then retry; STOP\n' >&2; exit 1; }
 else
  printf 'PASS recovered W6: ai-w6-start never ran; no Mac runner or secret stage to clean\n' >"$PROOF_DIR/C1-no-start.txt"
 fi
fi
test ! -e "$PROOF_DIR/closed.txt"
test ! -e "$PROOF_DIR/close-result.json"
if test "$CLOSE_RESULT" = success && test "$WINDOW" = W6 && test "$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("keep_open",False) else "0")' "$INPUTS_FILE")" = 1; then
 ai_run ai-inputs
 test "$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND invalidated_at IS NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
elif test "$WINDOW" = W7 && test "$CLOSE_RESULT" = success; then
 W7_GATE_STATE=$(ai_ro -Atq --command 'SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-close: W7 gate state query expected success got failure; STOP\n' >&2; exit 1; }
 W7_RETAINED_GATE_STATE=$(cat "$PROOF_DIR/retirement-gate-state.txt") || { printf 'FAIL ai-close: W7 retirement-gate-state.txt expected present got missing; STOP\n' >&2; exit 1; }
 test "$W7_GATE_STATE" = "$W7_RETAINED_GATE_STATE" || { printf 'FAIL ai-close: W7 gate state expected retained-retirement-state got other; STOP\n' >&2; exit 1; }
elif test "$WINDOW" = W7; then
 # Recovered W7: ai-w7-recovery preserved W6's measured OPEN/CLOSED state; do not require CLOSED.
 test -f "$PROOF_DIR/W7-recovery.txt" || { printf 'FAIL ai-close: recovered W7 W7-recovery.txt expected present got missing; STOP\n' >&2; exit 1; }
 test -f "$PROOF_DIR/W7-recovery-expected.json" || { printf 'FAIL ai-close: recovered W7 W7-recovery-expected.json expected present got missing; STOP\n' >&2; exit 1; }
 W7_KEEP=$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1]))["keep_open"] else "0")' "$PROOF_DIR/W7-recovery-expected.json") || { printf 'FAIL ai-close: recovered W7 keep_open expected readable got failure; STOP\n' >&2; exit 1; }
 W7_GEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$PROOF_DIR/W7-recovery-expected.json") || { printf 'FAIL ai-close: recovered W7 generation expected readable got failure; STOP\n' >&2; exit 1; }
 if test "$W7_KEEP" = 1; then
  W7_RECOVERED_STATE=$(ai_ro -Atq --command 'SELECT admin_issuance_enabled AND invalidated_at IS NULL AND release_generation='"$W7_GEN"' FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-close: recovered W7 keep-open query expected success got failure; STOP\n' >&2; exit 1; }
  test "$W7_RECOVERED_STATE" = t || { printf 'FAIL ai-close: recovered W7 issuance expected preserved-open-at-W6-generation got other; STOP\n' >&2; exit 1; }
 else
  W7_RECOVERED_STATE=$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NULL AND release_generation='"$W7_GEN"' FROM commonswarm_oauth.admin_cutover_state WHERE singleton;') || { printf 'FAIL ai-close: recovered W7 closed-state query expected success got failure; STOP\n' >&2; exit 1; }
  test "$W7_RECOVERED_STATE" = t || { printf 'FAIL ai-close: recovered W7 issuance expected preserved-closed-at-W6-generation got other; STOP\n' >&2; exit 1; }
 fi
elif test "$WINDOW" = W2 && test ! -e "$PROOF_DIR/apply-started.txt"; then
 # W2 stopped before its fence: admin_cutover_state does not exist yet; prove the ledger matches the open capture.
 test -f "$PROOF_DIR/ledger-at-open.txt" && test ! -L "$PROOF_DIR/ledger-at-open.txt" || { printf 'FAIL ai-close: pre-fence W2 ledger-at-open.txt expected captured-at-open got missing; STOP\n' >&2; exit 1; }
 W2_NOW=$(ai_ro -Atq --command "SELECT version FROM supabase_migrations.schema_migrations WHERE version LIKE '20261003%' ORDER BY version;") || { printf 'FAIL ai-close: pre-fence W2 ledger query expected success got failure; STOP\n' >&2; exit 1; }
 W2_OPEN=$(cat "$PROOF_DIR/ledger-at-open.txt") || { printf 'FAIL ai-close: pre-fence W2 ledger-at-open.txt expected readable got failure; STOP\n' >&2; exit 1; }
 test "$W2_NOW" = "$W2_OPEN" || { printf 'FAIL ai-close: pre-fence W2 ledger expected unchanged-from-open-capture got other; STOP\n' >&2; exit 1; }
elif test "$WINDOW" != W1; then
 test "$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;')" = t
fi
if test "$WINDOW" = W2 -o "$WINDOW" = W2b && test "$CLOSE_RESULT" = recovered && test -f "$PROOF_DIR/issuer-provisioning-attempted.txt" && test ! -L "$PROOF_DIR/issuer-provisioning-attempted.txt"; then
 # This window owned issuer provisioning: a recovered W2/W2b leaves no issuer login.
 test ! -e /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-close: recovered %s credential file expected absent got present; STOP\n' "$WINDOW" >&2; exit 1; }
 test ! -L /etc/commonswarm-oauth/admin-issuer-database-credentials || { printf 'FAIL ai-close: recovered %s credential file expected absent got symlink; STOP\n' "$WINDOW" >&2; exit 1; }
 W2_RECOVERED_ISSUER=$(ai_ro -Atq --command "SELECT NOT rolcanlogin AND rolpassword IS NULL FROM pg_catalog.pg_authid WHERE rolname='commonswarm_admin_issuer';") || { printf 'FAIL ai-close: recovered %s issuer role query expected success got failure; STOP\n' "$WINDOW" >&2; exit 1; }
 test "$W2_RECOVERED_ISSUER" = t || { printf 'FAIL ai-close: recovered %s issuer role expected NOLOGIN-without-password got other; STOP\n' "$WINDOW" >&2; exit 1; }
fi

if test "$WINDOW" = W3 && test "$CLOSE_RESULT" = recovered; then
 # A recovered W3 leaves the baseline live and no tree at this release (ai-w3-rollback moved it aside), so a
 # same-version retry preflight finds its one admissible state.
 python3 - /home/commonswarm/oauth "$INPUTS_FILE" <<'PY' || { printf 'FAIL ai-close: recovered W3 oauth current expected baseline and release tree expected absent got other; run ai-w3-rollback; STOP\n' >&2; exit 1; }
import json,os,sys
base=sys.argv[1]; d=json.load(open(sys.argv[2]))
ok=os.path.realpath(os.path.join(base,'current'))==os.path.join(base,'releases',d['baseline_oauth_sha']) and not os.path.lexists(os.path.join(base,'releases',d['release_sha']))
raise SystemExit(0 if ok else 1)
PY
 W3_RECOVERED_IMAGE=$(docker inspect --format '{{.Image}}' commonswarm-oauth-oauth-1) || { printf 'FAIL ai-close: recovered W3 running image expected readable got failure; STOP\n' >&2; exit 1; }
 test "$W3_RECOVERED_IMAGE" = "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseline_oauth_image"])' "$INPUTS_FILE")" || { printf 'FAIL ai-close: recovered W3 running image expected baseline got other; STOP\n' >&2; exit 1; }
fi
if test "$WINDOW" = W4 && test "$CLOSE_RESULT" = recovered; then
 # A recovered W4 leaves the baseline edge, the baseline Caddy bytes, no recycle drop-in and no tree at this release.
 python3 - /home/commonswarm/edge "$INPUTS_FILE" /etc/caddy "/etc/systemd/system/$EDGE_RECYCLE_SERVICE.d/50-admin-measurement.conf" <<'PY' || { printf 'FAIL ai-close: recovered W4 edge current, Caddy bytes, drop-in and release tree expected baseline-baseline-absent-absent got other; run ai-w4-rollback; STOP\n' >&2; exit 1; }
import hashlib,json,os,sys
base,inputs,caddy,dropin=sys.argv[1:5]; d=json.load(open(inputs))
def digest(p): return hashlib.sha256(open(p,'rb').read()).hexdigest() if os.path.isfile(p) and not os.path.islink(p) else None
ok=(os.path.realpath(os.path.join(base,'current'))==os.path.join(base,'releases',d['baseline_edge_sha'])
    and not os.path.lexists(os.path.join(base,'releases',d['release_sha'])) and not os.path.lexists(dropin)
    and digest(os.path.join(caddy,'sites/20-commonswarm-mcp.caddy'))==d['baseline_mcp_caddy_sha256']
    and digest(os.path.join(caddy,'sites/10-commonswarm-api.caddy'))==d['baseline_api_caddy_sha256']
    and digest(os.path.join(caddy,'Caddyfile'))==d['baseline_caddyfile_sha256'])
raise SystemExit(0 if ok else 1)
PY
fi
if test "$WINDOW" = W7; then
 systemctl start "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-close: W7 recycle timer restore expected success got failure; STOP\n' >&2; exit 1; }
 systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-close: W7 recycle timer expected active after restore got inactive; STOP\n' >&2; exit 1; }
 trap - EXIT INT TERM || true
fi
systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" || { printf 'FAIL ai-close: recycle timer expected active got inactive; re-arm with ai-w4-timer-recovery and report to HezLead; STOP\n' >&2; exit 1; }
# Final ruling validation BEFORE the stage is removed: a refusal here leaves the window retryable.
if test "${W2_UNPROVEN_RULING:-0}" = 1; then W2_ACCEPT_PAYLOAD=$(w2_unproven_ruling final); fi
if test ! -e "$PROOF_DIR/secret-stage.path"; then
 test ! -L "$PROOF_DIR/secret-stage.path" || { printf 'FAIL ai-close: secret-stage.path expected absent-or-regular got symlink; STOP\n' >&2; exit 1; }
 printf 'PASS ai-close: no secret stage was created; nothing to remove\n'
else
python3 - "$SECRET_STAGE" "$PROOF_DIR/secret-stage.path" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert pathlib.Path(sys.argv[2]).read_text().strip()==str(p)
# NEGATIVE-CONTROL /private/: Darwin-shaped path that must not match the box /tmp stage regex; not a live stage.
for denied in ['', '/', str(pathlib.Path.home()),'/tmp/other','/tmp/anvil-secret.abcdef/child','/private/tmp/anvil-secret.abcdef']:
    assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',denied) is None
assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) and p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p
assert p.stat().st_mode & 0o777==0o700
PY
# Use guarded PATH rm; a refusal stops cleanup.
rm -r -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; retain path and exact guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE" || { printf 'FAIL ai-close: removed SECRET_STAGE expected absent got present; STOP\n' >&2; exit 1; }
test ! -L "$SECRET_STAGE" || { printf 'FAIL ai-close: removed SECRET_STAGE expected not-symlink got symlink; STOP\n' >&2; exit 1; }
fi
if test "${W2_UNPROVEN_RULING:-0}" = 1; then
 # Exactly the validated payload, from memory; the ruling file is not read again.
 printf '%s\n' "$W2_ACCEPT_PAYLOAD" >"$PROOF_DIR/dcr-probe-revoke-accepted.json"
 printf 'REVOKE-UNPROVEN accepted by HezLead ruling; recorded with the close\n'
fi
# The explicit terminal record (result and time) is written with closed.txt; later windows read it.
CLOSED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$INPUTS_FILE" "$CLOSE_RESULT" "$CLOSED_AT" "$PROOF_DIR/close-result.json" <<'PY'
import json,pathlib,sys
d=json.load(open(sys.argv[1]))
pathlib.Path(sys.argv[4]).write_text(json.dumps({'release_sha':d['release_sha'],'window':d['window'],'window_id':d['window_id'],'result':sys.argv[2],'closed_at':sys.argv[3]},sort_keys=True)+'\n')
PY
printf '%s\n' "$CLOSED_AT" >"$PROOF_DIR/closed.txt"
printf 'PASS window closed %s; nonsecret proofs retained\n' "$CLOSE_RESULT"
fi
```

```sh
# step: ai-open-abort
# readonly: no
# host: box root; no production operation occurred before failed open
set -euo pipefail
: "${PROOF_DIR:?}"
if test ! -e "$PROOF_DIR"; then
 printf 'PASS ai-open-abort: PROOF_DIR never created; no secret stage was created\n'
elif test -e "$PROOF_DIR/probe-staged.txt" || test -L "$PROOF_DIR/probe-staged.txt"; then
 printf 'FAIL ai-open-abort: a W2 DCR probe grant was staged; use the recovered ai-close, which revokes it; STOP\n' >&2; exit 1
elif test ! -e "$PROOF_DIR/secret-stage.path"; then
 test ! -L "$PROOF_DIR/secret-stage.path" || { printf 'FAIL ai-open-abort: secret-stage.path expected absent-or-regular got symlink; STOP\n' >&2; exit 1; }
 ABORT_SCAN=$(python3 - "$PROOF_DIR" <<'PY'
import os,re,stat,sys
root=sys.argv[1]
p=os.path.join(root,'secret-stage.path')
assert not os.path.lexists(p)
found=[]
try: names=os.listdir('/tmp')
except OSError: names=[]
for name in names:
    if re.fullmatch(r'anvil-secret\.[A-Za-z0-9]{6}',name) is None: continue
    path='/tmp/'+name
    try:
        st=os.lstat(path)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode): continue
        if stat.S_IMODE(st.st_mode)!=0o700: continue
        if st.st_uid not in (0, os.geteuid()): continue
        if os.listdir(path): continue
    except OSError: continue
    found.append(path)
print('PASS ai-open-abort: no secret stage was recorded; candidates listed for manual review')
if found:
    print('\n'.join(sorted(found)))
PY
) || { printf 'FAIL ai-open-abort: unrecorded-stage listing expected success got failure; STOP\n' >&2; exit 1; }
 date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/aborted-before-mutation.txt"
 printf '%s\n' "$ABORT_SCAN" >>"$PROOF_DIR/aborted-before-mutation.txt"
 printf '%s\n' "$ABORT_SCAN"
 printf 'PASS ai-open-abort: aborted before mutation\n'
else
SECRET_STAGE=$(cat "$PROOF_DIR/secret-stage.path")
python3 - "$SECRET_STAGE" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_mode & 0o777==0o700
PY
rm -r -- "$SECRET_STAGE" || { printf 'FAIL cleanup refused %s; report guard message; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
test ! -e "$SECRET_STAGE"
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/aborted-before-mutation.txt"
fi
```

Lost-shell recovered close (not W5) initializes one new persistent box root
shell with ai-recovery-env before ai-db-session, and one new persistent Mac
shell with ai-mac-recovery-env before ai-mac-close. Neither block is ai-open.
Derived paths come from the operator WINDOW, WINDOW_ID and transferred
INPUTS_FILE; they are never reconstructed from memory.

```sh
# step: ai-recovery-env
# readonly: no
# host: box root; fresh persistent shell; never ai-open
set -euo pipefail
unset RELEASE_SHA PROOF_DIR RELEASE_ROOT BOX_ARCHIVE_PATH SECRET_STAGE PLAN_FILE
: "${WINDOW:?FAIL ai-recovery-env: WINDOW expected operator-window got unset; STOP}"
: "${WINDOW_ID:?FAIL ai-recovery-env: WINDOW_ID expected operator-window-id got unset; STOP}"
: "${INPUTS_FILE:?FAIL ai-recovery-env: INPUTS_FILE expected transferred-inputs got unset; STOP}"
out=$(python3 - "$INPUTS_FILE" "$WINDOW" "$WINDOW_ID" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
def refuse(what): raise SystemExit('FAIL ai-recovery-env: '+what+'; STOP')
def resolved(path,label,kind):
    s=str(path)
    if not path.is_absolute(): refuse(label+' expected absolute-resolved-path got other')
    if os.path.realpath(s)!=s: refuse(label+' expected resolved-path got symlink-in-path')
    cur=pathlib.Path('/')
    for part in pathlib.Path(s).parts[1:]:
        cur=cur/part
        if cur.is_symlink(): refuse(label+' expected resolved-path got symlink-in-path')
    if kind=='dir':
        if path.is_symlink() or not path.is_dir(): refuse(label+' expected existing directory got missing-or-symlink')
    else:
        if path.is_symlink() or not path.is_file(): refuse(label+' expected regular-file got other')
src=pathlib.Path(sys.argv[1]); window=sys.argv[2]; wid=sys.argv[3]
if not (src.is_absolute() and src.is_file() and not src.is_symlink()): refuse('INPUTS_FILE expected absolute-regular-file got other')
try: d=json.loads(src.read_text())
except ValueError: refuse('INPUTS_FILE expected JSON object got other')
if window=='W5': refuse('WINDOW expected non-W5 recovered-close window got W5')
if window not in {'W1','W2','W2b','W3','W4','W6','W7'}: refuse('WINDOW expected recovered-close window got other')
if d.get('window')!=window: refuse('operator WINDOW expected inputs window got mismatch')
sha,in_wid=d.get('release_sha'),d.get('window_id')
if not isinstance(sha,str) or re.fullmatch('[0-9a-f]{40}',sha) is None: refuse('inputs release_sha expected full-sha got other')
if not isinstance(wid,str) or re.fullmatch('[A-Za-z0-9]{6}',wid) is None: refuse('WINDOW_ID expected six-alphanumeric got other')
if in_wid!=wid: refuse('operator WINDOW_ID expected inputs window_id got mismatch')
want_plan=d.get('plan_sha256')
if not isinstance(want_plan,str) or re.fullmatch('[0-9a-f]{64}',want_plan) is None: refuse('inputs plan_sha256 expected sha256 got other')
proof=pathlib.Path('/home/commonswarm/admin-issuance/release-proofs/'+sha+'-'+window+'-'+wid)
resolved(proof,'PROOF_DIR','dir')
info=proof.stat()
if stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid not in (0, os.geteuid()): refuse('PROOF_DIR expected 0700 owner-matched got other')
transferred=proof/'inputs.json'
if not (transferred.is_file() and not transferred.is_symlink()): refuse('transferred inputs.json expected regular-file got other')
if transferred.read_bytes()!=src.read_bytes(): refuse('transferred inputs.json expected identical-to-INPUTS_FILE got mismatch')
root=pathlib.Path('/home/commonswarm/admin-issuance/releases/'+sha)
resolved(root,'RELEASE_ROOT','dir')
marker=root/'RELEASE_SHA'
if not (marker.is_file() and not marker.is_symlink()) or marker.read_text().strip()!=sha: refuse('RELEASE_ROOT/RELEASE_SHA expected this-release got other')
archive=pathlib.Path('/tmp/admin-issuance-'+sha+'-'+wid+'.tar')
if not (archive.is_file() and not archive.is_symlink()): refuse('BOX_ARCHIVE_PATH expected uploaded archive got missing-or-other')
if stat.S_IMODE(archive.stat().st_mode)!=0o600: refuse('BOX_ARCHIVE_PATH expected mode 0600 got other')
if hashlib.sha256(archive.read_bytes()).hexdigest()!=d.get('archive_sha256'): refuse('BOX_ARCHIVE_PATH digest expected inputs archive_sha256 got mismatch')
plan=root/'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'
resolved(plan,'PLAN_FILE','file')
if hashlib.sha256(plan.read_bytes()).hexdigest()!=want_plan: refuse('PLAN_FILE digest expected inputs plan_sha256 got mismatch')
pointer=proof/'secret-stage.path'
if pointer.is_symlink(): refuse('secret-stage.path expected absent-or-regular got symlink')
if not pointer.exists(): refuse('secret-stage.path expected recorded-stage got absent; use ai-open-abort')
if not pointer.is_file(): refuse('secret-stage.path expected regular-file got other')
p=pathlib.Path(pointer.read_text().strip())
# NEGATIVE-CONTROL /private/: Darwin-shaped path that must not match the box /tmp stage regex; not a live stage.
for denied in ['', '/', str(pathlib.Path.home()),'/tmp/other','/tmp/anvil-secret.abcdef/child','/private/tmp/anvil-secret.abcdef']:
    assert re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',denied) is None
if re.fullmatch(r'/tmp/anvil-secret\.[A-Za-z0-9]{6}',str(p)) is None or not p.is_dir() or p.is_symlink() or p.resolve(strict=True)!=p or stat.S_IMODE(p.stat().st_mode)!=0o700:
    refuse('SECRET_STAGE expected /tmp/anvil-secret.XXXXXX 0700 directory got other')
def sh(name,value):
    print(name+'='+json.dumps(value))
sh('WINDOW',window); sh('WINDOW_ID',wid); sh('RELEASE_SHA',sha)
sh('PROOF_DIR',str(proof)); sh('RELEASE_ROOT',str(root)); sh('BOX_ARCHIVE_PATH',str(archive))
sh('PLAN_FILE',str(plan)); sh('SECRET_STAGE',str(p))
print("printf '%s\\n' "+json.dumps('PASS ai-recovery-env: WINDOW WINDOW_ID RELEASE_SHA PROOF_DIR RELEASE_ROOT BOX_ARCHIVE_PATH PLAN_FILE SECRET_STAGE set from existing proof'))
PY
) || exit 1
eval "$out"
: "${WINDOW:?}" "${WINDOW_ID:?}" "${RELEASE_SHA:?}" "${PROOF_DIR:?}" "${RELEASE_ROOT:?}" "${BOX_ARCHIVE_PATH:?}" "${PLAN_FILE:?}" "${SECRET_STAGE:?}"
```

```sh
# step: ai-mac-recovery-env
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
unset PREP_DIR
: "${INPUTS_FILE:?FAIL ai-mac-recovery-env: INPUTS_FILE expected transferred-inputs got unset; STOP}"
out=$(python3 - "$INPUTS_FILE" <<'PY'
import hashlib,json,os,pathlib,re,stat,sys
def refuse(what): raise SystemExit('FAIL ai-mac-recovery-env: '+what+'; STOP')
src=pathlib.Path(sys.argv[1])
if not (src.is_absolute() and src.is_file() and not src.is_symlink()): refuse('INPUTS_FILE expected absolute-regular-file got other')
try: d=json.loads(src.read_text())
except ValueError: refuse('INPUTS_FILE expected JSON object got other')
want=d.get('archive_sha256')
if not isinstance(want,str) or re.fullmatch('[0-9a-f]{64}',want) is None: refuse('inputs archive_sha256 expected sha256 got other')
root='/private/tmp/'
try: names=os.listdir(root)
except OSError: names=[]
found=[]
for name in names:
    if re.fullmatch(r'admin-issuance-prep\.[A-Za-z0-9]{6}',name) is None: continue
    p=pathlib.Path(root+name)
    if re.fullmatch(r'/private/tmp/admin-issuance-prep\.[A-Za-z0-9]{6}',str(p)) is None: continue
    if p.is_symlink() or not p.is_dir(): continue
    if p.resolve(strict=True)!=p or stat.S_IMODE(p.stat().st_mode)!=0o700: continue
    archive=p/'release.tar'
    if not (archive.is_file() and not archive.is_symlink()): continue
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=want: continue
    found.append(p)
if len(found)==0: refuse('PREP_DIR expected one matching-prep-dir got zero')
if len(found)>1: refuse('PREP_DIR expected one matching-prep-dir got several')
print('PREP_DIR='+json.dumps(str(found[0])))
print("printf '%s\\n' "+json.dumps('PASS ai-mac-recovery-env: PREP_DIR set from matching prep directory'))
PY
) || exit 1
eval "$out"
: "${PREP_DIR:?}"
```

```sh
# step: ai-mac-close
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
: "${PREP_DIR:?}"
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm
python3 - "$PREP_DIR" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/admin-issuance-prep\.[A-Za-z0-9]{6}',str(p))
assert p.is_dir() and not p.is_symlink() and p.resolve(strict=True)==p and p.stat().st_mode & 0o777==0o700
PY
rm -r -- "$PREP_DIR" || { printf 'FAIL cleanup refused %s; report exact guard message; STOP\n' "$PREP_DIR" >&2; exit 1; }
test ! -e "$PREP_DIR"
```

Archives on the box are nonsecret and retained for W6 remeasurement. Do not
remove immutable release/proof directories; future retention is a separate
assignment. Every close is recorded in the operator's LOG.md with actual
start/end, identities, gate/probe receipts, approved rollback decision and
secret cleanup outcome. This preparation LOG contains no execution claims.
