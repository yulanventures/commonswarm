# C1 build B — second-pass runbook (2026-10-11)

This is the operator assembly of the five independently reviewed Lane 5 fragments. Final R is **`2e2ac5e63e851cc84f345a65b3547de365e8ea2e`** (`2e2ac5e6`). The worktree contains STGGATE, DRILL-LOCAL, the U9 kit, the X2 class/validator changes, W4X, K1 (5a7ef2ca, merged at R), K1c (699e0014, merged at R), and origin/main 964d733b (merged at R', ruling 63). This document records reviewed source and required future actions; it does not claim main landing, dispatch, production installation or live measurement.

Every HezLead ruling in `/Users/yulanbot/work/c1-frozen-resume/build-b/HEZLEAD-RULINGS.md` is binding. A later ruling overrides an earlier ruling and the draft. In particular: keeper additions 11–16; backup/restore 17–20; Lane 2 closure 33 and opening gate 37; exact paths 39; fragment/backup/X2 decisions 40; staging/DRILL 41–43 and 46; ARCH cut 44; and W4X 45 including 45(2), both part-2 addenda and 45(7); amendments 50–54 override the earlier staging baseline, delete/credential scope and ARCH order and U9 backup path. The draft's M §§2,4,6–7 split is preserved as sections **01 measurements → 02 backup-only install/U7 → 03 keeper/U9 → 04 X2 fixture → 05 identities/W1/order/freeze**. Operational pass order is in section 05.

**STOP rule:** any unresolved citation, unfilled required placeholder, missing review/signature/receipt, source or measurement mismatch STOPs before the dependent action. No production value is inferred. `<MEASURED:...>` names a later measurement owned in the row or the placeholder register; it is never executable input until filled and admitted. Final R `2e2ac5e63e851cc84f345a65b3547de365e8ea2e` must have its exact reviewed main-landing and CI receipts before release. Any subsequent source change requires a reviewed re-pin and citation check before dispatch.

HezLead signs operator/staging receipts and dispatches the authorized release worker. This drafting worker runs no operator block, Alloy, Docker, browser, box/staging/production operation, workflow or Git mutation. The code fences below are operator instructions. They preserve the reviewed checks and operator fences; new W4X actions invoke the reviewed C block rather than introduce release-plan discovery files. Wildcard deletion and a stack install are not part of this pass. Caddy work occurs only inside the reviewed W4 plan.

Repository aliases, all at final R:

| Alias | Repository source |
|---|---|
| C / PLAN_FILE | `docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md` |
| E | `deploy/edge-runtime/EDGE-RELEASE.md` |
| SITE | `docs/evidence/2026-10-02-site-release/SITE-RELEASE.md` |
| O | `deploy/mcp-auth/OAUTH-RELEASE.md` |
| STACK/ | `deploy/supabase-stack/` |
| BK/ | `deploy/supabase-stack/backup/` |
| MIG/ | `deploy/supabase-stack/migrate/` |
| DRILL | `deploy/supabase-stack/backup/restore-drill.py` |
| NOTIFY | `deploy/supabase-stack/backup/notify-healthcheck.py` |
| X | `tests/p1-server/admin-principal-lock-order.test.ts` |
| H (section 04) | `tests/support/admin-principal-lock-order-harness.mjs` |
| GATES | `docs/evidence/2026-10-03-admin-issuance-release/GATES.json` |
| KIT/ | `scripts/c1-staging-u9/` |

External authority aliases: B = `/Users/yulanbot/work/c1-frozen-resume/build-b`; P/PLAN = B/PLAN.md; brief = B/dispatch/LANE-5-BRIEF-draft.md; GAP = `/Users/yulanbot/work/c1-frozen-resume/C1-GAP-A-REPORT.md`; FEAS = `/Users/yulanbot/work/c1-frozen-resume/C1-OPT2-FEASIBILITY.md`; ARCH = `/Users/yulanbot/work/c1-next/ARCHIVE-DURABLE-REPORT.md`; INSTALL = `/Users/yulanbot/work/recycle-archive-keeper/INSTALL.md`; FU = `/Users/yulanbot/work/c1-verify/review/FOLLOW-UPS-C1.md`. LB = B/reviews/lane-6-round-B.md; CHECKLIST = `/Users/yulanbot/work/c1-prod-handoff-1388b0ee/PRODUCTION-PRE-WINDOW-CHECKLIST.md`; W5TASK = `/Users/yulanbot/work/c1-run/TASK-W5-1388b0ee.md`; CTRLBEFORE = `/Users/yulanbot/work/c1-run/CONTROLS-W5-before-1388b0ee.md`; CTRLTEMPLATE = `/Users/yulanbot/work/c1-run/CONTROLS-WINDOW-TEMPLATE.md`. These are external files, not Git objects at R; they remain at their given paths. Their citations and the binding rulings are checked separately in [CITATIONS.md](CITATIONS.md). No workspace instruction or receipt is copied into this repository.

Assembly source checks: DRILL sha256 `1f8e5c4b12dfe9a1f11cdb67e622b4c6d1223a7b9235d466185e6ae0dd1d9786`; NOTIFY sha256 `9534e9c9cd79620e6477d40db49351e5d808a493f4b2195c915d7955a058df0b`; schema algorithm **sha256-schema-ddl-v3**. These supplied pins match final R (DRILL:345; C:5856–5857).

## Window admission — every production and staging window

Before **EVERY** production or staging window opens, the dispatched operator runs this one admission fence with HezLead's planned open/end in UTC, full reviewed R, measured host, window/case ID and a fresh absolute receipt path in the admitted 0700 proof directory. Receipt output is exclusive root:root 0600 and binds those inputs, admission time, next recycle slot and rule version. Missing/invalid inputs or any refusal STOP before opening. HezLead adopts its digest in the window receipt; open/end must match it, and any schedule change requires fresh admission before open. No window may continue beyond its admitted end. This applies to OAuth, backup-only/U7 operations, U9 ARCH controls, the separate U9 dump/drill/status step, every U9 W4 success/failure case, production W4/W5, each X2 staging variant, W6 and W7; administrative W1 uses it if a window is opened. The keeper's independent **15-minute quiet rule remains additional**, including its installation/retirement checks. [Ruling 53(a)]

```bash
set -euo pipefail
: "${C1_PLANNED_OPEN_UTC:?}" "${C1_PLANNED_END_UTC:?}" "${RELEASE_SHA:?}" "${C1_ADMITTED_HOST:?}" "${C1_WINDOW_CASE_ID:?}" "${C1_ADMISSION_RECEIPT:?}"
python3 - "$C1_PLANNED_OPEN_UTC" "$C1_PLANNED_END_UTC" "$RELEASE_SHA" "$C1_ADMITTED_HOST" "$C1_WINDOW_CASE_ID" "$C1_ADMISSION_RECEIPT" <<'PY_ADMISSION'
import datetime as dt, hashlib, json, os, pathlib, re, stat, sys
UTC = dt.timezone.utc
def need(value, reason):
    if not value: raise SystemExit('STOP: ' + reason)
def utc(value):
    need(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value), 'UTC timestamp YYYY-MM-DDTHH:MM:SSZ required')
    try: return dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=UTC)
    except ValueError: raise SystemExit('STOP: invalid UTC timestamp')
opened, ended = map(utc, sys.argv[1:3]); sha, host, case, target = sys.argv[3:]
now = dt.datetime.now(UTC)
need(now <= opened < ended, 'future open and end after open required')
need(re.fullmatch(r'[0-9a-f]{40}', sha), 'full reviewed R required')
need(host == os.uname().nodename and case and len(case) <= 128, 'measured host/window binding required')
day = opened.replace(hour=0, minute=0, second=0, microsecond=0)
slots = [day + dt.timedelta(days=d, hours=h, minutes=30) for d in (0, 1) for h in (3, 9, 15, 21)]
need(not any(slot - dt.timedelta(minutes=35) <= opened <= slot for slot in slots), 'open inside 35-minute pre-recycle band or at recycle slot')
next_slot = min(slot for slot in slots if slot > opened)
need(ended < next_slot, 'end at or after next recycle slot')
for d in (0, 1):
    band = day + dt.timedelta(days=d, hours=12)
    need(not (opened < band + dt.timedelta(minutes=90) and ended > band), 'window intersects PromptEden 12:00:00-13:30:00Z')
path = pathlib.Path(target)
need(path.is_absolute() and '..' not in path.parts and path.parent.resolve(strict=True) == path.parent, 'absolute canonical receipt parent required')
need(os.geteuid() == 0, 'root operator required')
info = path.parent.lstat()
need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o700), 'root:root 0700 proof directory required')
for ancestor in path.parent.parents:
    info = ancestor.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe proof ancestor')
receipt = dict(kind='c1-window-admission', rule='ruling-53a-v1', release_sha=sha, host=host, window_case_id=case, planned_open_utc=sys.argv[1], planned_end_utc=sys.argv[2], admitted_at=now.isoformat(), next_recycle_slot=next_slot.isoformat(), result='PASS')
raw = (json.dumps(receipt, sort_keys=True) + '\n').encode()
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'wb') as out:
    os.fchmod(out.fileno(), 0o600); out.write(raw); out.flush(); os.fsync(out.fileno())
fd = os.open(path.parent, os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
print(json.dumps(dict(receipt=str(path), sha256=hashlib.sha256(raw).hexdigest(), result='PASS'), sort_keys=True))
PY_ADMISSION
```

## Code-owned deletes

Ruling 51 permits only the listed deletes by reviewed, pinned code. **Every operator-level delete uses the installed rm guard. Any delete outside this table STOPs.** A glob here bounds code retention; it never authorizes an operator wildcard delete. BK, DRILL, C and KIT rows are resolved at final R. K1 (`5a7ef2ca`, merged at R) retains exactly the four archive.py unlink sites below; its final-R file sha256 is `4bfffec742b11392af09ac1cf12586e17feef919dd084309051f17269f7f6376`. The delete bounds were checked against that Git source by content. No generic parent-tree removal is admitted. [Ruling 51; KIT/archive.py:60,144,168,187]

| Code file:line | Exact path or glob | Creator | Bound |
|---|---|---|---|
| BK/dump-database.sh:20–21 | `${TMPDIR:-/tmp}/commonswarm-backup-credentials.XXXXXX`, the exact directory returned by this invocation's `mktemp -d` and held in `$protected_dir` | This dump-database.sh invocation | EXIT trap removes only this invocation's credential temp directory and its contents; never the artifact parent or dump output directory |
| DRILL:101–124 | `/var/backups/commonswarm-postgres/restore-drill/<this-run-32-hex>/database.env` | This DRILL invocation | Credential file in this run's workdir; never another run or parent |
| DRILL:101–124 | `/var/backups/commonswarm-postgres/restore-drill/<this-run-32-hex>/storage.env` | This DRILL invocation | Same-run credential only |
| DRILL:101–124 | `/var/backups/commonswarm-postgres/restore-drill/<this-run-32-hex>/pass` | This DRILL invocation | Same-run credential only |
| DRILL:449–478,518; DRILL:41–43,506,517–518 | `/var/backups/commonswarm-postgres/restore-drill/[0-9a-f]{32}/` and its contained artifacts | DRILL's own earlier/current workdirs | Direct non-symlink child matching `re.fullmatch('[0-9a-f]{32}', name)`; retain 2 including current; recursive removal only inside that child, never the retention parent; symlinks are unlinked, never followed |
| C:6041; C:5847 | `/usr/local/lib/systemd/system/commonswarm-edge-recycle.service.d/00-w4-exclusion.conf` | This window's W4X take | Exact root-owned bytes checked; terminal success/recovered record durable first |
| C:6051–6052; C:5858–5860 | `/etc/systemd/system/timers.target.wants/commonswarm-w4-hold-alert.timer` | This window's W4X take | Exact link target; stop owned alert units before unlink |
| C:6051–6052; C:5858–5859 | `/usr/local/lib/systemd/system/commonswarm-w4-hold-alert.service` | This window's W4X take | Exact alert configuration bytes/metadata verified; terminal release only |
| C:6051–6052; C:5858–5859 | `/usr/local/lib/systemd/system/commonswarm-w4-hold-alert.timer` | This window's W4X take | Exact alert configuration bytes/metadata verified; terminal release only |
| C:6054; C:5848 | `/var/lib/commonswarm-admin-release/w4-exclusion.json` | This window's W4X take | Exact release/window binding; gate unloaded and alert removed first |
| C:6055; C:5861 | `/usr/local/lib/systemd/system/commonswarm-edge-recycle.service.d/w4-hold.py` | This window's W4X take | Exact pinned script bytes/metadata; terminal release only |
| C:6056–6058; C:5982–5987 | Only absent-at-take directories recorded in this window's `w4-exclusion-taken.json.created_dirs` under the exact W4X paths above | This window's W4X take | Reverse recorded order, empty directory only; never a pre-existing parent |
| C:6082–6092 | `$PROOF_DIR/w4-recycle-pending.json` | This window's W4X rollback-aware recycle | Same release/window/admission/exclusion and healthy restart verified; durable completed receipt first |
| KIT/archive.py:187 | `$PROOF_DIR/u9-ARCH-legacy.tar` | This ARCH run's exclusive aside copy | Created inode/digest/owner/mode binding; only after restored live archive verified |
| KIT/archive.py:60 | Exclusive copy-failure path: `$PROOF_DIR/u9-ARCH-legacy.tar`, `$PROOF_DIR/u9-ARCH-config.json`, `$PROOF_DIR/u9-ARCH-before.json`, or exact bound live archive during restoration | This ARCH copy call | Only the inode this call exclusively created; identity equality before failure unlink |
| KIT/archive.py:144 | Before-receipt failure temps: `$PROOF_DIR/u9-ARCH-legacy.tar` and `$PROOF_DIR/u9-ARCH-config.json` | This ARCH run | Only recorded created inodes; original bound live archive untouched |
| KIT/archive.py:168 | `/tmp/admin-issuance-<sha40>-<suffix6>.tar`, exact path in this run's `u9-ARCH-before.json.observation.archive` | Pre-existing admitted legacy release archive; explicit ruling-51 loss exception | **Reviewed ARCH loss step ONLY**; exact inode and digest rechecked against durable undo/aside; no parent, glob or other live archive; restore in control 3 |

# 01 — Production measurements U1–U8 and U10

Interface: HezLead supplies fresh production measurements, admitted inputs and signed receipts for the landed release R and this pass. This fragment supplies nine STOP rows to the assembled SECOND-PASS-RUNBOOK.md. U9 belongs to fragment 03. CSwarm Lead assembles the fragments; HezLead signs operator and staging review receipts (ruling 40(6); brief:9–19).

Citation base: all repository anchors resolve at final R `2e2ac5e63e851cc84f345a65b3547de365e8ea2e`. HezLead must record `<MEASURED:full landed release SHA>` equal to R before execution; a missing main landing, changed source or measurement mismatch STOPs (brief:9; P:103; ruling 40(1)).

Receipt convention: `PROOF_DIR` is the admitted box directory `/home/commonswarm/admin-issuance/release-proofs/<MEASURED:R>-W4-<MEASURED:window_id>` (C:1392). `U1-identities.json` through `U8-owner.json` and `U10-keeper.json` below are proposed nonsecret runbook attachments within that directory, not new validator keys. Record UTC measurement time, R, pass/window identity, source receipt paths and hashes, deciding observations and HezLead's approval. Preserve the exact existing A1 and gate receipt schemas (C:5362–5389; C:1875–1890).

Acceptance: exactly U1–U8 and U10 appear below, each with six fields and a source-resolved execution recheck; all live values remain `<MEASURED:...>` until HezLead records them. Drafting validation is a local whitespace, row-set and citation check only; no operator step is executed (task TASK-l5-F01; brief:9,62).

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| **U1 — production identities.** Resolve edge, OAuth, site and stack current paths; record their full release SHAs, RELEASE_SHA files, applicable image revision, container labels/images/mounts and the production d518d4c9 close receipts. Observations: `<MEASURED:resolved paths, full SHAs, image revisions, labels, images, mounts and close receipt bindings>`. | Every identity equals the admitted baseline inputs and the bound close receipts; explicitly prove whether edge release 3 d518d4c9 closed in production. OAuth image revision equals its source SHA; edge immutable mounts resolve to the admitted tree; stack PostgreSQL image and site target/source agree with inputs. Identity fields require full 40-hex SHAs (C:770–772). The site directory name carries the first 12 hex characters of the full admitted site SHA (C:1085–1088); resolve that prefix to the full identity (brief:10; P:101; C:67–70,1059–1100). | HezLead measures production. | Any path cannot be resolved; any identity or d518d4c9 close receipt is missing, unbound or mismatched; live state differs from the admitted baseline. | `PROOF_DIR/U1-identities.json`, with exact nonsecret close receipt paths/digests and admitted input references; existing close receipts remain in place. | `ai_run ai-box-preflight` immediately before open: C:1047. It checks live path/source/image/label/mount equality; HezLead must separately retain the bound d518d4c9 close evidence. |
| **U2 — complete fence and catalog equality.** Measure the fresh full fence projection, installed function and trigger definitions, owners and ACLs, issuance flag and migration checksum failure count. Observations: `<MEASURED:full projection, catalog definitions/owners/ACLs, issuance flag and checksum failure count>`. | Reviewed R predicates, function/trigger definitions, owners and ACLs all agree. Issuance is false; checksum failures are 0. The full fence has legacy closure time/evidence, no unrevoked legacy credentials or active v1 grants, enabled and FORCE RLS, no policies, and no effective table or column privileges for any revoked role, including grants inherited from PUBLIC (brief:11; P:102; E:788–806; C:4680–4703; supabase/migrations/20261003000003_admin_oauth_cutover.sql:267,423–499). | HezLead measures production. | Definition, owner, ACL or predicate drift; incomplete projection; issuance is open; checksum failures are nonzero or cannot be measured. An early-return fence call is not proof that the installed fence is complete. | `PROOF_DIR/U2-fence.json`, with complete nonsecret definition/owner/ACL comparison evidence; execution receipts `w4-measurement.json` and `W4-readback.txt`. | `ai_run ai-w4-preflight` at C:4025; full pre-write A6 fence recheck in `ai_run ai-w4-apply` at C:4654,4680–4703; `ai_run ai-w4-readback` at C:4872. E's exact full projection is `edge_fence` at E:788. Catalog equality remains a required signed U2 comparison; the boolean readback alone does not prove definitions/ACL equality. |
| **U3 — R, archive, plan, SQL and review gates.** Record the full landed R, archive and plan SHA-256, compare each of the twelve C1 SQL files with its recorded checksum evidence, and bind independent review/CI gates and both X2 CI/staging receipts to R. Observations: `<MEASURED:R, archive/plan hashes, twelve-file equality and gate receipt paths/digests>`. | Exact reviewed R bytes and required same-build receipts; one file per required SQL version and SHA-equal checksum evidence. Both distinct X2 receipts bind base T and lane R, identical five X2 files/test digest across T/R, and each run's migration tree. Execution R must contain the final 15 controls/classes from the race file's exported `X2_RACE_CLASSES`: one positive-control, 12 base-cycle and two regression-guard races. Lane 5 piece V amends the classifier per ruling 40: base-cycle FAIL-40P01 at T/PASS at head R; regression-guard PASS at T and head R; positive-control as today, preserving existing control receipt verdicts (test PASS at T/R with exactly one raw SQL 40P01 at each). Preserve controls arrays with sibling `x2_race_classes` and no new receipt field (brief:12,35–52; P:103; C:1869–1972,4749–4754; tests/p1-server/admin-principal-lock-order.test.ts:74–81; rulings 37(c),40(1)–(3),40(7)). | HezLead measures production inputs and admits the independent receipts; designated CI/staging owners supply their own evidence. | Missing/mismatched R, hash, SQL/checksum, independent receipt, test digest, tree binding or exact result set; receipts reused across CI/staging. STOP W6 admission until the reviewed class-aware validator and final 15-control gates are in execution R and accept both receipts. Final R contains the reviewed class-aware amendment: C:1944–1946 requires FAIL-40P01 only for base-cycle at T and PASS for every other T/R result. Independently admitted CI/staging receipts remain required. | `PROOF_DIR/U3-release.json`; admitted `GATE_RECEIPT_FILE` and its nonsecret `evidence_root` with the two X2 evidence files and hashes; box-bound `PROOF_DIR/gates.json` (C:1873–1909,1980). | `ai_run ai-inputs` at C:699; `ai_run ai-gates` at C:1869; `ai_run ai-gates-bind` at C:1978. Recheck per execution window: W4's required receipts before W4; both accepted X2 CI/staging receipts before W6 admission and any later opening window (brief:35–36; ruling 40(1)). |
| **U4 — admitted installation and pathname safety.** Read hook, drop-in, recycle.json, intent, unit and archive bytes without following links; record digests, canonical paths, uid/gid/modes, link counts, directory entries, timer/service states and archive/helper/live-tree manifests. Include each monitored ancestor and U10 keeper state. Observations: `<MEASURED:installation, metadata, paths, units and tree manifests>`. | A1 baseline equals live bytes/metadata. Installed old hook SHA-256 is `3f03038e7dde0e6402f3359f4abcf5815d847ca3d7fefcefa8ec0e31c7a5b5e6`; its upgrade requires a reviewed old/new binding. Hook root:root 0700; drop-in root:root 0644; config root:root 0600; recycle timer enabled/active and service inactive. **Ruling 39 additions: `/usr/local/libexec` root:root 0711 directory; `/etc/systemd/system/commonswarm-edge-recycle.service.d` root:root 0700 directory.** Other paths obey the exact admitted root/operator and inert-account exceptions, not a broad ownership exception; keeper state equals U10 (brief:13; P:104; C:3964–3973,4031–4280,5362–5446; rulings 31–34,39). | HezLead measures production. | Any inequality, unsafe/symlinked ancestor, unexpected type/link count/extra entry, partial installation, unapproved hook digest or unit/timer drift. Any other service `.d` is absent until a named reviewed step creates it as root with a stated mode; otherwise STOP for HezLead (ruling 39(b)). | `PROOF_DIR/U4-installation.json`; admitted `RECYCLE_BASELINE_FILE` with digest bound in inputs; saved exact `PROOF_DIR/w4-state/recycle-baseline.json`; `PROOF_DIR/w4-path-preflight.json` (C:4268,5362–5389,5489–5496). | `ai_run ai-w4-preflight` at C:4025 includes the no-write pathname audit and A1 admission via `ai-recycle-install` at C:4346,5282. `ai-w4-apply` rechecks A1 after timer hold and before switch at C:4717–4719. `ai-w4-state` snapshots monitored roots at C:5748. |
| **U5 — Caddy routes, redaction and Storage CORS.** Hash `/etc/caddy/sites/20-commonswarm-mcp.caddy`, `/etc/caddy/sites/10-commonswarm-api.caddy` and `/etc/caddy/Caddyfile`; inspect complete routes/imports, redaction/log filters and Storage CORS, including imported sites; validate the full candidate. Observations: `<MEASURED:three live hashes, complete inspection, candidate hashes and validation result>`. | Live hashes equal admitted snapshots. A5 admits absent routes with reviewed insertion, or complete equal routes with bytes preserved; partial, duplicate or different routes refuse. DPoP and DPoP-Nonce variants occur exactly once as deletes in each Authorization filter. Candidate derives from live snapshots, preserves Storage CORS and validates as the complete config; no section 9/API_CADDY_PAIR substitution (brief:14; P:105; C:1089–1092,4375–4516; FU #31–32). | HezLead measures production. | Live drift; incomplete inspection; partial/different/duplicate route, import or filter; lost Storage CORS; invalid full candidate. | `PROOF_DIR/U5-caddy.json`, with snapshot/candidate hashes, nonsecret reviewed diff and validation receipt. Candidate files and validation log stay in the admitted protected `SECRET_STAGE` used by C; no secret config content is copied into runbook attachments. | `ai_run ai-w4-preflight` at C:4025 after baseline hash admission in `ai-box-preflight` C:1047; `ai_run ai-w4-caddy-candidate` at C:4375, including full validation at C:4515; live comparison before installation and live validation after installation in `ai-w4-apply` C:4802–4809 and candidate equality in `ai-w4-readback` C:4872. |
| **U6 — preserve CLOSED measurement history.** Take a canonical nonsecret singleton snapshot and enumerate historical and current release-proof inventories before overwrite, with exact paths/digests and retained history. Observations: `<MEASURED:CLOSED singleton and reconciled historical/current proof inventories>`. | Issuance is CLOSED; history and complete proof inventories remain retained. The canonical pre-overwrite singleton has the exact 19-field projection, and a fresh after/rollback receipt links back to it; no old generation is restored (brief:15; P:106; C:3995–4010,4759–4800). | HezLead measures production. | Omitted inventory entry, missing/different retained proof, noncanonical snapshot, open issuance or history lost/overwritten. | `PROOF_DIR/U6-history.json` and digest-bound inventory manifests; execution `PROOF_DIR/cutover-before-measurement.json`, `w4-measurement.json` or `w4-rollback-measurement.json`. Existing historical/current proof directories remain in place. | `ai_run ai-w4-preflight` at C:4025 and its `ai-w4-state` snapshot at C:5748; exact A6 singleton capture immediately before overwrite in `ai_run ai-w4-apply` at C:4759–4767; after receipt at C:4776–4800; `ai_run ai-w4-readback` at C:4872. HezLead separately reconciles the historical/current proof inventory; the monitored-root snapshot does not replace it. |
| **U7 — real production backup and isolated restore.** Record backup `verified_at` and destination; named throwaway restore host/database, restore time (`restored_at`) and isolation proof; schema checksum and key-table counts against the backup source. Record Lane 6 backup-only install evidence and HezLead's signature. Observations: `<MEASURED:backup time/destination, restore identity/time, schema checksum, source/restore counts and signature>`. | Fresh verified production backup, actual isolated restore and matching integrity, signed for this pass. Status gate requires backup age 0–1800 s, database/object bytes verified and destination under `r2:yulan-vps-1-backups/000-commonswarm-postgres/`; restore is ok/complete with age 0–8 days. Before U7, the backup-only install (item 8) follows ruling 40(4) AMENDED: the new immutable release holds the WHOLE reviewed `deploy/supabase-stack/backup/` directory from R, with a SHA-256 manifest and `verify-counts.sh` at the Docker-visible path. Root:root 0644 drop-ins repoint only backup/drill units; daemon-reload follows. No edit inside `ec098859`, stack install or Caddy change; measure before/after Caddy hashes (unchanged), service/timer unit and drop-in hashes, complete installed file set and R-equal hashes. Rollback = remove the admitted drop-in(s) + daemon-reload. One manual backup plus drill must PASS with the exact new schema set including commonswarm_ops and migration_checksums count >0. This row only MEASURES and admits that evidence; section 02 supplies the operator install/rollback block and the full `ec098859`-vs-R differing-file list with review citations or STOP (brief:16,23–24; P:107; C:4018–4022,1776–1786,2212–2222; rulings 7,17,19,40(4) AMENDED; deploy/supabase-stack/backup/restore-drill.py:37–40,242–252). | HezLead measures production and signs the real restore/isolation record. | Missing, stale or unverified backup; missing actual restore, named host/database/time, integrity equality, isolation proof or HezLead signature; production target or staging stub used as proof; missing whole-directory manifest, Docker-visible verifier, cited differing-file list, backup-only install/rollback binding or manual backup/drill evidence; edit inside ec098859, changed Caddy hash or nonpositive checksum count. Status flags alone cannot satisfy U7. | `PROOF_DIR/U7-backup-restore.json`, signed and linked to section 02's exact install/rollback receipts, whole-directory SHA-256 manifest, reviewed differing-file list and manual backup/drill receipts; status sources `/var/backups/commonswarm-postgres/status.json` and `restore-status.json`; window-bound `PROOF_DIR/backup-gate.json`. | HezLead's signed manual U7 STOP before `ai-w4-preflight`, C:4018; `ai_run ai-w1-backup-gate` at C:2212; bound freshness recheck in `ai-w4-preflight` C:4282–4284 and at the mutation boundary in `ai-w4-apply` C:4706–4708. Real isolation/integrity remains a manual signed requirement (C:4020–4022). |
| **U8 — current owner, controls, consent and parked W5.** Measure fresh R-bound new-owner controls/consent receipts, human profile and workspace ownership proof; retain the approved administrative close and measured disposition/residue for parked W5 7Rh7NR. Observations: `<MEASURED:owner/workspace identities, unique controls pass, consent receipts and parked-W5 close evidence>`. | Identities and receipts match R and this pass; unique controls pass succeeds; human profile/workspace ownership is proven; 7Rh7NR is reconciled through the approved close before W4 with reason `owner-retired-seat-name-held`. Its close is administrative disposition, never W6 readiness (brief:17,54; P:108,118; C:4285–4311,9525,9573,9613; rulings 33,37(b)). | HezLead measures production. | Stale, foreign, unbound or missing owner/profile/workspace/controls/consent proof; reused controls identity; missing approval, close, disposition or residue for 7Rh7NR. Before issuance beyond owner smoke, missing FU #50 fix also STOPs (ruling 37(b)). | `PROOF_DIR/U8-owner.json`; `PROOF_DIR/ordinary-before.json` and `consent-pre-W1.json`; exact approved parked-W5 administrative-close receipt path/digest `<MEASURED:7Rh7NR close receipt and retained residue evidence>`. | Retained consent and ordinary controls in `ai_run ai-w4-preflight` at C:4025,4285–4311. Parked reconciliation feeds that admission: `ai_run ai-w5-admin-close` at C:9573 runs once before W4; section 05 supplies its operator procedure (brief:54; C:9575). |
| **U10 — keeper baseline after install.** After the install receipt time, measure the five keeper files, their no-follow digests/uid/gid/modes/link counts, three enable links, state directory metadata, archives directory, ledger bytes/rows, each archive name/digest/metadata, and recycle drop-in bytes/metadata. Bind the measurement to the install receipt SHA-256. Observations: `<MEASURED:post-install UTC time, install receipt digest and complete keeper/drop-in set>`. | Every observation equals the install receipt and all five files equal bundle SHA256SUMS. Five files are root:root, regular, one link: `/usr/local/libexec/commonswarm-recycle-archive` 0700; `/etc/systemd/system/commonswarm-recycle-archive-keep.service`, `/etc/systemd/system/commonswarm-recycle-archive-keep.timer`, `/etc/systemd/system/commonswarm-recycle-archive-restore.service` 0644; `/etc/tmpfiles.d/commonswarm-recycle-archive.conf` 0600. Three exact enable links equal their receipt targets; state root and archives directory root:root 0700, ledger/archive bytes and metadata equal receipt. HOST/UPLOAD_OWNER/BASELINE come only from `/Users/yulanbot/work/keeper-install-prod/REPORT.md`; receipt BASELINE/HOST equals box VARS and live three-file baseline. W4-uploaded INSTALL hash and four excerpt pins equal C:3984–3991 before extraction (brief:19–21; P:110; C:4560–4564,4586–4636,5417–5422; rulings 13–16). | HezLead measures production after the install receipt and signs the manual U10 STOP. | Pre-install or untimed measurement; missing/mismatched receipt digest, file/link/state/archive/drop-in value or bundle digest; RECEIPT/VARS/live inequality; missing reviewed bundle or wrong INSTALL/excerpt pins. STOP for HezLead; do not repair or choose one source silently. | `PROOF_DIR/U10-keeper.json`, bound to `/Users/yulanbot/work/keeper-install-prod/REPORT.md` SHA-256; exact U10 values carried in A1's `keeper` record and saved `PROOF_DIR/w4-state/recycle-baseline.json`. Keep VARS `/root/keeper-install-20261010T165121Z.vars` root 0600 on box only; keep bundle `/root/recycle-archive-keeper` payloads and SHA256SUMS until W4. | Manual W4 U10 STOP at C:4016 before `ai-w4-preflight`; A1 admission via `ai-recycle-install` C:5282,5417–5466; `ai_run ai-w4-keeper-retire` at C:4520 rechecks receipt/input binding, INSTALL/excerpts, three-source baseline and archive adoption digest equality before retirement (C:4586–4636). |

U7 restore rule: “Production backups lack commonswarm_ops until build B Lane 6 ships. After any production restore, re-apply the C1 migrations that create commonswarm_ops and verify the C1 checksum rows BEFORE admin issuance or any C1 window.” U7's final backup must include the installed Lane 6 format; do not use the pre-Lane-6 exception as final proof (brief:23; rulings 17,19; FU #38).

U10 handoff rule: read VARS as root on the box; never copy it to the Mac or print anything except BASELINE/HOST. The bundle has no INSTALL.md: W4 uses the digest-pinned uploaded copy. Quiet-slot distance must exceed 15 minutes from 03/09/15/21:30Z. Run the pinned preamble/bundle/quiet excerpts then INSTALL section 4 verbatim in one child shell; never section 1 in W4 (rulings 12–15; C:3978–3991,4602–4636). Section 03 supplies the keeper operator blocks and U9 rehearsal.

Rollback handoff: keeper remains RETIRED; durable state, ledger and archives remain. The recovered close says exactly “keeper retired; re-install required before reboot”. HezLead's checklist says “no reboot” until a fresh INSTALL sections 1–3 re-install receipt exists. Re-install requires a HezLead-signed STOP in the next quiet slot before reboot or W4 retry, followed by a new U10 measurement; no automatic re-install (ruling 11; C:4004–4010). Section 03 supplies that STOP procedure.

Rulings 18 and 20 govern the separate X2 staging restore procedure in section 04; its short-lived staging dumps and U9 status receipts do not satisfy production U7. Ruling 40(5), as amended by ruling 41, grants U9 separate staging-only backup authority; section 03 carries that procedure. Lane 2 stays closed under ruling 33's exceptions; FU #50 remains the opening gate beyond owner smoke under ruling 37(b). No production measurements or executions were performed while drafting this fragment (brief:56; rulings 18,20,33,37,40,41).

## Production W4 — W4X admission and recovery (ruling 45)

**FOLLOW-UPS-C1 #51/G5 and #52/G6 are fixed in code by reviewed W4X at final R. Production W4 still requires this runbook reviewed and dispatched, plus Tom's one-time dedicated W4 alert step.** Their older pending assessment is superseded by ruling 45 and the reviewed C changes. ARCH 4–5 stay cut; #53 remains after C1. #54/#56/#57 are recorded test/rigour follow-ups; #55/#58 concern other assigned surfaces. #50 remains the broader-issuance gate in section 05.

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| Dedicated W4 check and protected config: `<MEASURED:Tom W4 alert completion and delivery receipt>` | Tom creates ONE dedicated W4 Healthchecks check when W4 is scheduled: period 5 min, grace 10 min. On the box the authorized operator installs `/etc/commonswarm-admin-release/w4-healthcheck.env`, regular/no-symlink root:root 0600, ONE `HC_BACKUP_URL` in the same format as backup healthchecks.env. Its value is never printed, put on a command line or copied to receipts. R-bound notifier is root:root 0444 at `/opt/commonswarm-backup/releases/<R>/backup/notify-healthcheck.py` with the supplied digest (ruling 45(7); C:5851–5878; NOTIFY:30–45) | Tom creates check; HezLead admits nonsecret file/delivery proof; authorized worker installs through the protected secret path | Missing Tom step, file/channel, invalid owner/gid/mode/type/key/URL, unsafe notifier ancestor, notifier hash mismatch or initial ping failure: STOP before A1/exclusion admission | Signed Tom/HezLead alert prerequisite receipt and `PROOF_DIR/w4-exclusion-taken.json`; no capability URL in evidence | `ai-w4-preflight` calls `ai-w4-state take`; config/notifier validation C:5972–5977 and initial delivered ping/enabled alert before skip-gate publication C:5993–6007 |
| Durable exclusion before A1: `<MEASURED:window-bound take and terminal release>` | `ai-w4-preflight` takes the persistent service exclusion BEFORE A1/monitored-root snapshots. Root:root 0600 `/var/lib/commonswarm-admin-release/w4-exclusion.json` binds release/window/id, created_at and limits; service condition covers timer AND manual starts; persists across failure/reconnect/reboot. EXIT timer re-arm does not release it. Release only after durable success/recovered `close-result.json` + `closed.txt` (C:4340–4349,5847–5850,5987–6007,6010–6033,9285–9297) | HezLead; dispatched operator records | Missing/foreign/stale record, in-flight intent/generation drift, absent alert, pre-A1 take missing, premature exclusion removal or terminal mismatch: STOP and retain state for owning-window recovery | `w4-exclusion-taken.json`, `close-result.json`, `closed.txt`, `w4-exclusion-release-authorized.json`, `w4-exclusion-released.json` under PROOF_DIR | Take re-reads generation/intent before A1 (C:5967–5970,6213–6216); terminal fsync before release C:6027–6058; interrupted release uses `W4_STATE_ACTION=release` only against existing terminal records, never re-runs close C:9293–9297 |
| Hold ceiling/time and rollback-aware recycle: `<MEASURED:cgroup memory, record/restart age, alert and action receipt>` | Ceiling **1536 MiB = 1610612736 bytes**, cap **6 h = 21600 s**, while edge memory.max stays 2 GiB. Unhealthy edge, record age OR edge StartedAt age at/above 6 h, or memory.current at/above ceiling triggers STOP `/fail`. Each skipped run logs window id + age; independent root host timer checks every 5 min and survives lost W4 shell/reboot. Alert retains exclusion. HezLead finishes recovery/terminal close promptly or invokes the reviewed `ai-w4-state` with `W4_STATE_ACTION=rollback-recycle`; no service hooks, no authority writes, no silent release (rulings 45(2), both addenda,45(7); C:5863–5868,5904–5947,6082–6110,6209–6223) | HezLead owns response; authorized worker records host observations/receipt | Changed limits/cgroup, invalid/future age, unavailable observation/alert, silent skip, held recycle service start, wrong action or unhealthy restart: STOP, preserve exclusion/incident and pending receipt | Journal skip line, dedicated alert delivery/status receipt; bound `w4-rollback-aware-recycle-<digest>.json` or retained `w4-recycle-pending.json` | `hold` checks at rollback/reconnect; rollback-aware path compares intent/generation/invalidation/provenance and record before/after, new StartedAt/healthy readback; it never replaces rollback/close evidence (C:4889–4894,5030–5035,6083–6110,9357–9359) |
| G6 baseline approval after rollback: `<MEASURED:baseline approval receipt/live equality>` | `ai-w4-rollback` measures restored baseline archive/tree/mount/image and atomically reconciles approved_edge_release_sha to that measured baseline while CLOSED/invalidated; higher generation retained. `w4-baseline-approval.json` binds R/W4/id, baseline_binding_sha, before/after approval and fresh generation. Recovered release rechecks live approval, binding and rollback measurement before unloading exclusion (C:4917–4999,6014–6025) | HezLead admits; authorized rollback worker records | Missing/mismatched approval/measurement receipt, baseline binding/live approval drift, wrong generation, open issuance or cleared invalidation: STOP; exclusion remains | `w4-baseline-approval.json`, `w4-rollback-source.json`, `w4-rollback-measurement.json`, recovered close and exclusion release receipts | Rollback reconciliation C:4958–4994; terminal recovered release `baseline_approval()` C:6014–6025. Existing intent-drift refusal and exact recovered-close sets remain enforced (C:5702,6177–6203) |


# 02 — Backup-only install, restore proof and U7

Input: final R tree/manifest INCLUDING Lane 5 DRILL and W4X, fresh box measurements and HezLead's operator receipt. Output: install/rollback receipts, ONE manual backup/drill receipt and signed U7. Repository citations and comparison resolve at final R. BK = deploy/supabase-stack/backup/; MIG = deploy/supabase-stack/migrate/. DRILL-LOCAL's reviewed commit is aa386f6ea9cf4e79f718d17766c2aa2c1ae77662, present in R; DRILL:345 names sha256-schema-ddl-v3, DRILL:368–380 runs the four tools/proof, and DRILL:529–554 writes status before label-scoped cleanup and final status. Its sha256 is 1f8e5c4b12dfe9a1f11cdb67e622b4c6d1223a7b9235d466185e6ae0dd1d9786. The whole backup-only release must include W4X's notifier as well as DRILL. STOP on any R/review/digest mismatch. These blocks are for a later authorized operator; no box/staging contact by this maker. [Rulings 7,19,40(4) amended,42,45–46; DRILL:47–56,481–494; NOTIFY:30–45,86–95]

## Restore rule and order

“Production backups lack commonswarm_ops until build B Lane 6 ships. After any production restore, re-apply the C1 migrations that create commonswarm_ops and verify the C1 checksum rows BEFORE admin issuance or any C1 window.” [Ruling 17; FOLLOW-UPS-C1 #38; LANE-AMENDMENTS.md:40] Backup-only install → ONE manual backup plus REAL isolated drill → HezLead-signed U7 → W4. The final Lane-6-equipped backup must contain commonswarm_ops and a positive migration_checksums count; the older-backup restore rule is not an exception for this pass. Never run section 9 / API_CADDY_PAIR, install a stack, change stack/current, edit the ec098859 release, or change Caddy here. [Rulings 17, 19, 40(4) amended; C:4018–4022; FOLLOW-UPS-C1 #31]

## Reviewed scope and comparison

RELEASE contains the WHOLE reviewed BK directory from R, INCLUDING DRILL, plus the seven MIG helpers in the manifest block. Final R has 14 BK files; re-inventory R and STOP on any uncited difference. Unit/timer payloads remain inside RELEASE. This install's own mode rule is files 0444 (Git 100644) or 0555 (Git 100755), directories 0555, root:root; no symlinks, exact R bytes. The scripts resolve stack_dir from their parent at BK/run-backup.sh:9 and BK/dump-database.sh:12, then call the adjacent backup/migrate helpers at BK/run-backup.sh:21–22 and BK/dump-database.sh:24–27. [Rulings 40(4) amended,42; DRILL] The adjacent MIG files preserve the reviewed call chain: dump-source.sh sources lib.sh; the drill runs restore-target.sh, prepare-target.sh, restore-cron-jobs.sh and verify-counts.sh; prepare-target.sh also reads activity-publish-grants.sql. With BK/restore-drill.py at RELEASE/backup/, STACK_DIR is RELEASE; Docker binds that host directory read-only to /work and reads /work/migrate/verify-counts.sh. Thus the host verifier is RELEASE/migrate/verify-counts.sh, not the old stack verifier. [MIG/dump-source.sh:4; MIG/prepare-target.sh:98–104; BK/restore-drill.py:28,368–372]

Git resolves ec098859 to ec098859df48458c3079ca55c00ab09a8bed7e27. Comparison to final R finds these extra BK differences beyond the four originally named files; every other BK file has equal Git mode/blob. This is repository evidence. Reconcile the COMPLETE ec098859→R diff and its reviews before manifest admission; the DRILL changes below require the reviewed PASS/commit binding. Any extra uncited difference is STOP. [TASK-l5-F02b.md; TASK-l5-F02c.md; rulings 40(4) amended,42; DRILL] The Reviewed-By-Model trailer binds round-B PASS to b5daee4c, the Lane 6 changes to README.md, test_restore_drill.py and test_upload_snapshot.py; final R additionally includes the reviewed DRILL changes to the drill test and W4X changes to notifier/test_notify_healthcheck.py. MIG/verify-counts.sh also differs in that commit (LB:70–72); the other four M helpers beyond dump-source.sh/lib.sh are byte/mode-equal. R must additionally contain DRILL's restore-drill.py and test_restore_drill.py; verify reviewed bytes/ancestry and the complete diff before activation. [Git log/diff at ec098859/final R; rulings 40(4) amended,42; DRILL]

| Extra differing file (under BK) | ec098859 → final R | Lane / commit / review citation |
|---|---|---|
| README.md | Added #38 restore instruction; mode remains 100644 | Lane 6, b5daee4c592d9780368bc4c15d7d9a455ff7a6d6; LB:11 (all 12 receipt files), LB:62–72 (inventory), final VERDICT: PASS; BK/README.md:59 |
| test_restore_drill.py | Nine-schema/count controls at final R; R also carries DRILL proof, FAIL/cleanup and secret-exclusion controls | Lane 6 b5daee4c; LB:13–21,88, final PASS; Lane 5 DRILL piece, reviewed: aa386f6ea9cf4e79f718d17766c2aa2c1ae77662 Reviewed-By-Model Grok round 2 PASS; BK/test_restore_drill.py:113–213,283–395; DRILL:481–554; missing binding STOPs |
| test_upload_snapshot.py | Nine-schema fixtures, missing-ops/count and zero/positive-count controls; mode remains 100644 | Same Lane 6 commit; LB:13–21 (independent controls/mutations), LB:89 (9 OK), final VERDICT: PASS |
| notify-healthcheck.py | W4X adds the reviewed --config path and dedicated W4 notification; exact sha256 9534e9c9cd79620e6477d40db49351e5d808a493f4b2195c915d7955a058df0b; mode 100644, installed root:root 0444 | W4X d5c9febdba7203f3d0f6bc998c113c90bba3cafd Reviewed-By-Model Grok + Gemini PASS; NOTIFY:30–54,80–96; C:5851–5878 |
| test_notify_healthcheck.py | W4X config/root-mode and notification controls; mode 100644 | Same W4X commit/review; BK/test_notify_healthcheck.py:75–91 |

## Measurements and receipts

HezLead measures production. Keep <MEASURED:...> until recorded. RECEIPT is a NEW root-owned 0700 directory outside RELEASE, for nonsecret hashes, modes, counts, identities and signatures; never env files, dumps or customer content. [Rulings 7, 19, 40(4); WORKER-RULES.md]

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| Payload inventory, modes and SHA256 | Whole B plus seven named M helpers, exact R bytes; frozen modes, root:root, one link; no extras/links (ruling 40(4) amended) | HezLead | Missing/extra file, wrong R, mutable payload or digest mismatch | RECEIPT/payload.manifest and release identity | Repeat complete manifest check before activation and manual run |
| Live Caddy files before/after | UNCHANGED full file-set and byte hashes (rulings 19, 40(4); C:1089) | HezLead | Any addition/removal/hash change | RECEIPT/{before,after,after-manual,rollback}.json, caddy | Snapshot and compare after install, manual runs and rollback |
| Four service/timer files and all drop-ins | Base files and pre-existing drop-ins unchanged; only two new root 0644 drop-ins in root 0755 dirs; only backup/drill ExecStart changed (rulings 39(b), 40(4)) | HezLead | Other change, unsafe metadata, unexpected effective command or timer state | RECEIPT snapshots and dropins.installed.sha256 | Re-enumerate FragmentPath/DropInPaths; compare all hashes and effective command digests |
| Manual backup and drill | ONE each, new invocation IDs, same new verified destination, exact nine schemas, migration_checksums >0, matched integrity, owned cleanup complete; DRILL emits container/database/restored_at, named schema checksums and key-table counts BEFORE cleanup (rulings 17,40(4),42; BK/restore-drill.py:242–252,368–372; DRILL) | HezLead | Failed/stale/unbound run, missing DRILL field/review, wrong schemas/counts or cleanup failure | RECEIPT/manual.json, written in §5 from the native statuses | Re-read statuses, artifact digests and exact DRILL fields |
| U7: backup verified_at/destination; REAL isolated host/database/restored_at; source/target schema checksum and key-table counts; signature | Fresh verified backup, actual throwaway restore, matching integrity and HezLead signature for R/pass (rulings 7,42; C:4018); backup age 0–1800s, restore age 0–8 days (C:1781–1786) | HezLead | Missing/stale field/proof/signature, production/stub target or isolation/integrity mismatch | PROOF_DIR/U7-backup-restore.json (section 01 U7), binding RECEIPT/manual.json; W4 LOG.md links its digest | Manual STOP C:4018; ai-w1-backup-gate C:2212; BOTH ai-backup-gate-check rechecks: ai-w4-preflight C:4282–4284 AND ai-w4-apply C:4706–4708 |

## 1. Pin the complete manifest on the Mac

The later operator runs bash. EXPECTED is NEW. Admit the final R's DRILL PASS/commit binding and complete difference table FIRST, then generate the manifest and transfer it with that exact tree through the approved release upload. Rebind all line anchors/inventory to R; absent/mismatched review or DRILL fields STOPs. No secrets come to the Mac. [Rulings 40(4) amended,42; PLAN.md §3; DRILL]
```text
set -euo pipefail
REPO='/Users/yulanbot/work/c1b-lanes/integration'
R='2e2ac5e63e851cc84f345a65b3547de365e8ea2e'
DRILL='aa386f6ea9cf4e79f718d17766c2aa2c1ae77662'
EXPECTED='<MEASURED:new-operator-receipt-path>/payload.manifest'
test "$(git -C "$REPO" rev-parse "${R}^{commit}")" = "$R"
git -C "$REPO" merge-base --is-ancestor "$DRILL" "$R"
git -C "$REPO" diff --name-status ec098859 "$R" -- deploy/supabase-stack/backup/
python3 - "$REPO" "$R" "$EXPECTED" <<'PYCODE'
import hashlib,subprocess,sys
repo,r,out=sys.argv[1:]; base='deploy/supabase-stack/'; entries={}
def git(*a): return subprocess.check_output(['git','-C',repo,*a])
for line in git('ls-tree','-r',r,'--',base+'backup/').decode().splitlines():
    meta,path=line.split('\t'); mode,kind,blob=meta.split(); assert kind=='blob' and mode in ('100644','100755'); entries[path[len(base):]]=mode
assert entries, 'whole reviewed backup directory required; STOP'
for name in ('dump-source.sh','lib.sh','restore-target.sh','prepare-target.sh','restore-cron-jobs.sh','verify-counts.sh','activity-publish-grants.sql'):
    entries['migrate/'+name]=git('ls-tree',r,'--',base+'migrate/'+name).decode().split()[0]
with open(out,'x') as f:
    for path,mode in sorted(entries.items()):
        assert mode in ('100644','100755'); frozen='0444' if mode=='100644' else '0555'
        f.write(f'{path}\t{frozen}\t{hashlib.sha256(git("show",r+":"+base+path)).hexdigest()}\n')
PYCODE
```

## 2. Record the baseline, then stop the two timers

The remaining blocks run later in ONE root bash session. TREE/EXPECTED are admitted R inputs. Validate canonical root-owned non-writable ancestors before writes; create absent /opt/commonswarm-backup and releases as root 0755 only. Never change existing ancestors. Wait at most 900s (5s polls) for active backup/drill jobs BEFORE stopping timers; then recheck idle after stopping to catch a timer race. Timeout STOPs; never kill a job. [Rulings 39(b),40(4); BK/README.md:128–131]
```text
set -euo pipefail; umask 077
R='2e2ac5e63e851cc84f345a65b3547de365e8ea2e'
TREE='<MEASURED:verified-uploaded-R-tree>'
EXPECTED='<MEASURED:uploaded-R-bound-payload.manifest>'
RECEIPT='<MEASURED:new-root-owned-0700-receipt-directory>'
RELEASE="/opt/commonswarm-backup/releases/$R"
test "$(id -u)" = 0; test "$(id -g)" = 0
python3 - "$TREE" "$EXPECTED" "$RECEIPT" "$RELEASE" <<'PYCODE'
import pathlib,stat,sys
tree,manifest,receipt,release=map(pathlib.Path,sys.argv[1:]); roots=[pathlib.Path('/opt/commonswarm-backup'),pathlib.Path('/opt/commonswarm-backup/releases')]
assert tree.is_dir() and manifest.is_file() and receipt.parent.is_dir()
for p in (tree,manifest,receipt,release):
    assert p.is_absolute() and p.resolve()==p
    for q in [p,*p.parents]:
        if not q.exists(): assert q in (receipt,release,*roots); continue
        s=q.lstat(); assert s.st_uid==s.st_gid==0 and not s.st_mode & 0o022
        assert stat.S_ISREG(s.st_mode) if q==manifest else stat.S_ISDIR(s.st_mode)
assert not receipt.exists() and not release.exists()
for p in roots:
    if not p.exists(): p.mkdir(mode=0o755); p.chmod(0o755)
PYCODE
test ! -e "$RECEIPT"; test ! -L "$RECEIPT"; mkdir -m 0700 "$RECEIPT"
install -o root -g root -m 0600 "$EXPECTED" "$RECEIPT/payload.manifest"
snapshot() {
  python3 - "$RECEIPT/$1.json" <<'PYCODE'
import hashlib,json,pathlib,re,stat,subprocess,sys
def measure(name):
    p=pathlib.Path(name); s=p.lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and not s.st_mode & 0o022
    for parent in p.parents: a=parent.lstat(); assert stat.S_ISDIR(a.st_mode) and a.st_uid==a.st_gid==0 and not a.st_mode & 0o022
    return dict(sha256=hashlib.sha256(p.read_bytes()).hexdigest(),mode=oct(stat.S_IMODE(s.st_mode)))
def prop(u,k): return subprocess.check_output(['systemctl','show',u,'-p',k,'--value'],text=True).strip()
units={}; states={}; commands={}; dropin_dirs={}
for kind in ('backup','restore'):
    for suffix in ('service','timer'):
        u=f'commonswarm-postgres-{kind}.{suffix}'; f=prop(u,'FragmentPath'); assert f.startswith('/')
        units[u]={p:measure(p) for p in [f]+prop(u,'DropInPaths').split()}
        states[u]={k:prop(u,k) for k in ('ActiveState','UnitFileState')}
        if suffix=='timer': assert states[u]['ActiveState'] in ('active','inactive'); states[u]['NextElapseUSecRealtime']=prop(u,'NextElapseUSecRealtime')
        if suffix=='service':
            d=pathlib.Path(f'/etc/systemd/system/{u}.d')
            for parent in d.parents: s=parent.lstat(); assert stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and not s.st_mode & 0o022
            if not d.exists() and not d.is_symlink(): dropin_dirs[str(d)]=None
            else:
                s=d.lstat(); assert stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0; dropin_dirs[str(d)]=dict(uid=s.st_uid,gid=s.st_gid,mode=oct(stat.S_IMODE(s.st_mode)))
            commands[u]={k:hashlib.sha256(json.dumps(re.findall(r'\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(.*?) ;',prop(u,k))).encode()).hexdigest() for k in ('ExecStart','ExecStartPre','ExecStopPost')}
root=pathlib.Path('/etc/caddy'); assert root.is_dir() and not root.is_symlink() and not any(p.is_symlink() for p in root.rglob('*'))
caddy={str(p):measure(str(p)) for p in sorted(root.rglob('*')) if not p.is_dir()}
assert all(p in caddy for p in ('/etc/caddy/Caddyfile','/etc/caddy/sites/10-commonswarm-api.caddy','/etc/caddy/sites/20-commonswarm-mcp.caddy'))
if pathlib.Path(sys.argv[1]).name=='before.json': assert all(v is None for v in dropin_dirs.values()), 'pre-existing drop-in directory; STOP'
with open(sys.argv[1],'x') as out: json.dump(dict(caddy=caddy,units=units,states=states,commands=commands,dropin_dirs=dropin_dirs),out,sort_keys=True,indent=2)
PYCODE
}
idle() {
  for u in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do s=$(systemctl show "$u" -p ActiveState --value); [[ "$s" = inactive || "$s" = failed ]] || return 1; done
}
wait_idle() {
  local deadline=$((SECONDS+900))
  until idle; do (( SECONDS < deadline )) || { printf 'STOP: backup/drill still active after 900s\n' >&2; return 1; }; sleep 5; done
}
wait_idle; snapshot before
systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer; idle
```

## 3. Create and verify the NEW immutable release; activate two drop-ins

The file manifest is checked against both TREE and RELEASE, including the exact file set. Its modes are installed explicitly, then checked before activation. No copying over live unit files, stack installation or Caddy operation. Drop-in directories must be absent (ruling 39(b)); this step creates only the two named root 0755 directories and root 0644 files. ExecStart alone changes: healthcheck hooks, maintenance locks, user/timeouts and timers stay as admitted. Check effective-command digests (without changing timestamps), Caddy and base/pre-existing unit bytes BEFORE any service start and again after the manual runs. [Ruling 40(4) amended; BK/commonswarm-postgres-backup.service:7–17; BK/commonswarm-postgres-restore.service:7–17; BK/run-backup.sh:7–8; BK/restore-drill.py:500–505]
```text
python3 - "$TREE/deploy/supabase-stack" "$RELEASE" "$RECEIPT/payload.manifest" <<'PYCODE'
import hashlib,pathlib,stat,sys
src,dst,m=map(pathlib.Path,sys.argv[1:]); assert not dst.exists() and not dst.is_symlink()
rows=[line.split('\t') for line in m.read_text().splitlines()]; expected={p for p,mode,h in rows}; assert len(expected)==len(rows)
assert {str(p.relative_to(src)) for p in (src/'backup').rglob('*') if not p.is_dir()}=={p for p in expected if p.startswith('backup/')}
dst.mkdir(mode=0o700); (dst/'backup').mkdir(mode=0o700); (dst/'migrate').mkdir(mode=0o700)
for path,mode,h in rows:
    assert pathlib.PurePosixPath(path).parts[0] in ('backup','migrate') and len(pathlib.PurePosixPath(path).parts)==2
    assert mode in ('0444','0555') and len(h)==64 and (src/path).resolve()==src/path
    s=(src/path).lstat(); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1; data=(src/path).read_bytes(); assert hashlib.sha256(data).hexdigest()==h
    with (dst/path).open('xb') as f: f.write(data)
    (dst/path).chmod(int(mode,8))
for d in (dst/'backup',dst/'migrate',dst): d.chmod(0o555)
PYCODE
verify_payload() {
  python3 - "$RELEASE" "$RECEIPT/payload.manifest" <<'PYCODE'
import hashlib,pathlib,stat,sys
root,m=map(pathlib.Path,sys.argv[1:]); rows=[l.split('\t') for l in m.read_text().splitlines()]
assert {str(p.relative_to(root)) for p in root.rglob('*') if not p.is_dir()}=={p for p,mode,h in rows}
assert {str(p.relative_to(root)) for p in root.rglob('*') if p.is_dir()}=={'backup','migrate'}
for p in [root,*root.rglob('*')]:
    s=p.lstat(); assert s.st_uid==s.st_gid==0 and not stat.S_ISLNK(s.st_mode)
    if p.is_dir(): assert stat.S_IMODE(s.st_mode)==0o555
for path,mode,h in rows:
    p=root/path; s=p.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==int(mode,8) and hashlib.sha256(p.read_bytes()).hexdigest()==h
PYCODE
}
verify_payload
for kind in backup restore; do
  d="/etc/systemd/system/commonswarm-postgres-$kind.service.d"
  test ! -e "$d"; test ! -L "$d"
  if [[ "$kind" = backup ]]; then cmd="/bin/bash $RELEASE/backup/run-backup.sh"; else cmd="/usr/bin/python3 $RELEASE/backup/restore-drill.py"; fi
  h=$(printf '[Service]\nExecStart=\nExecStart=%s\n' "$cmd" | sha256sum | awk '{print $1}')
  printf '%s  %s\n' "$h" "$d/40-c1b-backup-only.conf"
done >"$RECEIPT/dropins.installed.sha256"
for kind in backup restore; do
  d="/etc/systemd/system/commonswarm-postgres-$kind.service.d"
  test ! -e "$d"; test ! -L "$d"; mkdir -m 0755 "$d"; chmod 0755 "$d"
  if [[ "$kind" = backup ]]; then cmd="/bin/bash $RELEASE/backup/run-backup.sh"; else cmd="/usr/bin/python3 $RELEASE/backup/restore-drill.py"; fi
  (set -o noclobber; printf '[Service]\nExecStart=\nExecStart=%s\n' "$cmd" >"$d/40-c1b-backup-only.conf")
  chmod 0644 "$d/40-c1b-backup-only.conf"
done
sha256sum --check "$RECEIPT/dropins.installed.sha256"; systemctl daemon-reload; snapshot after
check_install() {
  python3 - "$RECEIPT/before.json" "$RECEIPT/$1.json" "$RELEASE" <<'PYCODE'
import hashlib,json,sys
b,a=(json.load(open(p)) for p in sys.argv[1:3]); release=sys.argv[3]; assert b['caddy']==a['caddy'], 'Caddy changed; STOP'
for u,files in b['units'].items():
    extra=set(a['units'][u])-set(files); assert all(a['units'][u].get(p)==v for p,v in files.items()), 'base unit/drop-in changed; STOP'
    assert b['states'][u]['UnitFileState']==a['states'][u]['UnitFileState']
    if u.endswith('.timer'): assert not extra and a['states'][u]['ActiveState']=='inactive'
    else:
        d=f'/etc/systemd/system/{u}.d/40-c1b-backup-only.conf'; assert extra=={d} and a['units'][u][d]['mode']=='0o644'
        assert b['dropin_dirs'][d.rsplit('/',1)[0]] is None and a['dropin_dirs'][d.rsplit('/',1)[0]]==dict(uid=0,gid=0,mode='0o755')
        kind='backup' if u.endswith('-backup.service') else 'restore'
        tool='/bin/bash' if kind=='backup' else '/usr/bin/python3'; name='run-backup.sh' if kind=='backup' else 'restore-drill.py'
        expected=hashlib.sha256(json.dumps([(tool,f'{tool} {release}/backup/{name}','no')]).encode()).hexdigest(); assert a['commands'][u]['ExecStart']==expected, 'effective ExecStart mismatch; STOP'
        for k in ('ExecStartPre','ExecStopPost'): assert b['commands'][u][k]==a['commands'][u][k]
PYCODE
  sha256sum --check "$RECEIPT/dropins.installed.sha256"
  verify_payload
}
check_install after; idle
```

## 4. Rollback: remove ONLY these drop-ins and daemon-reload

Validate BOTH sides before any rm: the manifest names exactly two admitted drop-ins; each directory was ABSENT in before.json and is either already gone or lstat-confirmed root:root 0755 with only its digest-admitted root 0644 conf (or empty). Any other state STOPs with no rm. Remove admitted confs via guarded rm, recheck directory ownership/mode/emptiness, then rmdir; daemon-reload runs only after every removal succeeds, including a one-sided partial install. Preserve release directories, archives and keeper state; report refusals. [Rulings 39(b),40(4); TASK-l5-F02c.md; TASK-l5-F02d.md; WORKER-RULES.md] On partial creation or any failed check, STOP with timers stopped; snapshot the state and remove only task-created, digest-admitted drop-ins using the rollback path. Never adopt or remove a pre-existing file. Keep the release/receipts for inspection. [Ruling 40(4); WORKER-RULES.md]
```text
wait_idle
systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer; idle
snapshot pre-rollback
python3 - "$RECEIPT/before.json" "$RECEIPT/dropins.installed.sha256" <<'PYCODE'
import hashlib,json,pathlib,re,stat,subprocess,sys
b=json.load(open(sys.argv[1])); dirs=[pathlib.Path(f'/etc/systemd/system/commonswarm-postgres-{k}.service.d') for k in ('backup','restore')]; name='40-c1b-backup-only.conf'
rows=[line.split() for line in pathlib.Path(sys.argv[2]).read_text().splitlines()]
assert len(rows)==2 and all(len(row)==2 and re.fullmatch(r'[0-9a-f]{64}',row[0]) for row in rows), 'invalid drop-in manifest; STOP'
hashes={p:h for h,p in rows}; assert set(hashes)=={str(d/name) for d in dirs}, 'drop-in manifest path set differs; STOP'
def checked_dir(d):
    s=d.lstat(); assert stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o755, 'directory unsafe; STOP'
present=[]
for d in dirs:
    assert str(d) in b['dropin_dirs'] and b['dropin_dirs'][str(d)] is None, 'directory baseline not absent; STOP'
    try: checked_dir(d)
    except FileNotFoundError: continue
    p=d/name; contents=set(d.iterdir()); assert contents in (set(),{p}), 'unexpected directory content; STOP'
    if contents:
        s=p.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o644, 'conf unsafe; STOP'
        assert hashlib.sha256(p.read_bytes()).hexdigest()==hashes[str(p)], 'conf digest differs; STOP'
    present.append((d,p,bool(contents)))
for d,p,has_conf in present:
    checked_dir(d)
    if has_conf: subprocess.run(['rm','--',str(p)],check=True)
    checked_dir(d); assert not list(d.iterdir()), 'directory nonempty; STOP'
    subprocess.run(['rmdir','--',str(d)],check=True)
PYCODE
systemctl daemon-reload; snapshot rollback
python3 - "$RECEIPT/before.json" "$RECEIPT/rollback.json" <<'PYCODE'
import json,sys
b,r=(json.load(open(p)) for p in sys.argv[1:]); assert b['caddy']==r['caddy'], 'Caddy changed; STOP'
assert b['units']==r['units'] and b['commands']==r['commands'], 'unit/drop-in/effective command changed; STOP'
assert b['dropin_dirs']==r['dropin_dirs'], 'directory baseline changed; STOP'
assert all(b['states'][u]['UnitFileState']==r['states'][u]['UnitFileState'] for u in b['states'])
PYCODE
```

After successful rollback or HezLead-signed U7, restore ONLY timers active in before.json; enabled state stays unchanged. Both timers are persistent: finish/re-arm at least 300 seconds before their measured next fire (exclude the randomized-delay/catch-up interval), or STOP with timers stopped for HezLead; no catch-up run is admitted here. Do not start an old backup/drill to test rollback. Rollback restores the old schema limitation and blocks U7 for this pass. This is separate from W4 keeper rollback: ruling 11 keeps the keeper RETIRED and requires fresh re-install before reboot/retry; ruling 14's keeper receipt/VARS/live equality still applies. [Rulings 11, 14, 17, 40(4); BK/README.md:147–149; BK/commonswarm-postgres-backup.timer:5–7; BK/commonswarm-postgres-restore.timer:5–7]
```text
python3 - "$RECEIPT/before.json" <<'PYCODE'
import json,subprocess,sys,time
b=json.load(open(sys.argv[1])); prop=lambda u,k: subprocess.check_output(['systemctl','show',u,'-p',k,'--value'],text=True).strip()
for u,s in b['states'].items():
    if u.endswith('.timer'):
        assert s['ActiveState'] in ('active','inactive')
        if s['ActiveState']=='active':
            assert time.time()+300<float(subprocess.check_output(['date','-d',s['NextElapseUSecRealtime'],'+%s'],text=True)), 'timer quiet interval missed; STOP'
            subprocess.run(['systemctl','start',u],check=True)
        assert all(prop(u,k)==s[k] for k in ('ActiveState','UnitFileState'))
PYCODE
systemctl list-timers commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
```

## 5. ONE manual backup and drill; then U7

R MUST contain the reviewed Lane 5 DRILL piece. It writes container id, database, restored_at, named source/target schema checksums and named key-table counts to restore-status.json BEFORE cleanup, including partial FAIL evidence; final cleanup status remains authoritative. U7 reads EXACTLY those fields from this ONE manual backup+drill; missing field/review binding STOPs, with no side capture or second drill. [Rulings 7,19,40(4),42; TASK-l5-F02d.md; Lane 5 DRILL piece, reviewed: aa386f6ea9cf4e79f718d17766c2aa2c1ae77662 Reviewed-By-Model Grok round 2 PASS; DRILL:529–554]
```text
DRILL_ALGORITHM='sha256-schema-ddl-v3'
[[ -n "$DRILL_ALGORITHM" && "$DRILL_ALGORITHM" != *'<'* && "$DRILL_ALGORITHM" != *'>'* ]] || { printf 'STOP: reviewed DRILL algorithm unfilled\n' >&2; exit 1; }
check_install after; idle
systemctl show commonswarm-postgres-backup.service commonswarm-postgres-restore.service -p InvocationID -p Result -p ExecMainStatus >"$RECEIPT/manual-before.txt"; date -u +%Y-%m-%dT%H:%M:%S.%6NZ >"$RECEIPT/backup-start.txt"
systemctl start commonswarm-postgres-backup.service
systemctl show commonswarm-postgres-backup.service -p InvocationID -p Result -p ExecMainStatus >"$RECEIPT/backup-result.txt"; date -u +%Y-%m-%dT%H:%M:%S.%6NZ >"$RECEIPT/backup-end-drill-start.txt"
systemctl start commonswarm-postgres-restore.service
systemctl show commonswarm-postgres-restore.service -p InvocationID -p Result -p ExecMainStatus >"$RECEIPT/drill-result.txt"; date -u +%Y-%m-%dT%H:%M:%S.%6NZ >"$RECEIPT/drill-end.txt"
snapshot after-manual; check_install after-manual
python3 - "$RECEIPT" "$R" "$DRILL_ALGORITHM" <<'PYCODE'
import datetime,hashlib,json,os,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); old=set(re.findall(r'InvocationID=(\w+)',(p/'manual-before.txt').read_text()))
def utc(v):
    assert isinstance(v,str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)',v), 'missing/invalid UTC time; STOP'
    return datetime.datetime.fromisoformat(v.replace('Z','+00:00'))
def status(name,result,keys):
    path=pathlib.Path('/var/backups/commonswarm-postgres')/name; raw=path.read_bytes(); d=json.loads(raw)
    props=dict(line.split('=',1) for line in (p/result).read_text().splitlines() if '=' in line)
    assert props['Result']=='success' and props['ExecMainStatus']=='0' and re.fullmatch(r'[0-9a-f]{32}',props['InvocationID']) and props['InvocationID'] not in old
    assert d['invocation_id']==props['InvocationID'] and d['ok'] is True
    return {k:d[k] for k in keys}, hashlib.sha256(raw).hexdigest()
b,bh=status('status.json','backup-result.txt',('ok','invocation_id','verified_at','destination','database_bytes_verified','object_bytes_verified'))
r,rh=status('restore-status.json','drill-result.txt',('ok','state','at','invocation_id','destination','database_verified','all_files_verified','label','restore_container_id','database','restored_at','schema_checksums','key_table_counts'))
assert b['database_bytes_verified'] is True and b['object_bytes_verified'] is True and r['state']=='complete' and r['database_verified'] is True and r['all_files_verified'] is True
assert r['destination']==b['destination'] and b['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/')
start=utc((p/'backup-start.txt').read_text().strip()); restore_start=utc((p/'backup-end-drill-start.txt').read_text().strip()); end=utc((p/'drill-end.txt').read_text().strip())
assert start<=utc(b['verified_at'])<=restore_start<=utc(r['restored_at'])<=utc(r['at'])<=end
assert 0<=(datetime.datetime.now(datetime.timezone.utc)-utc(b['verified_at'])).total_seconds()<=1800
assert re.fullmatch(r'[0-9a-f]{64}',r['restore_container_id']) and r['database']=='postgres' and re.fullmatch(r'commonswarm\.drill=[0-9a-f]{32}',r['label'])
c=r['schema_checksums']; assert set(c)=={'algorithm','source','target'} and c['algorithm']==sys.argv[3] and re.fullmatch(r'[0-9a-f]{64}',c['source']) and c['source']==c['target'], 'schema checksum/algorithm differs; STOP'
tables={'auth.users','storage.objects','swarm.agent_tokens','commonswarm_oauth.provider_artifacts','commonswarm_ops.migration_checksums'}; assert set(r['key_table_counts'])==tables
for counts in r['key_table_counts'].values():
    assert set(counts)=={'source','target'} and all(type(v) is int and v>=0 for v in counts.values()) and counts['source']==counts['target']
assert r['key_table_counts']['commonswarm_ops.migration_checksums']['source']>0
with (p/'manual.json').open('x') as f: json.dump(dict(release_sha=sys.argv[2],host=os.uname().nodename,restore_started_at=restore_start.isoformat(),backup=b,restore=r,status_sha256={'backup':bh,'restore':rh}),f,sort_keys=True,indent=2)
PYCODE
```

The block writes RECEIPT/manual.json using allowlisted native fields, identities, hashes and counts. Missing keys raise STOP; timestamps/new invocation IDs bind the single run. Reconcile protected artifact SHA256SUMS/COMPLETE.json, exact nine-schema manifest, ALL selected table counts and owned cleanup; no journal/env/customer content in receipts. Timers stay stopped until acceptance; failure STOPs for checked rollback. [BK/run-backup.sh:12–31; BK/restore-drill.py:242–252,272–293,368–372,445–446,481–554 at final R; BK/upload-snapshot.py:19–37; MIG/verify-counts.sh:36–55; rulings 40(4),42; DRILL] HezLead writes/signs PROOF_DIR/U7-backup-restore.json, section 01 U7's EXACT path. Bind <MEASURED:R/pass>, manifest/install/manual/status digests and invocation IDs; read container id, database, restored_at, schema_checksums.algorithm/source/target and key_table_counts DIRECTLY from this drill JSON via manual.json. Use that single restored_at as the restore time; add measured host, isolated-label/network/no-production-target evidence, cleanup proof and <MEASURED:HezLead signature/time>; compare the full selected count inventory. Absent field, mismatched checksum/count or unsigned isolation STOPs U7/W4. [Rulings 7,42; C:4018–4022; MIG/verify-counts.sh:36–55; section 01 U7; Lane 5 DRILL piece, reviewed: aa386f6ea9cf4e79f718d17766c2aa2c1ae77662 Reviewed-By-Model Grok round 2 PASS; DRILL:299–321,345–380,529–554]

Run ai-w1-backup-gate (C:2212), then BOTH bound ai-backup-gate-check rechecks: ai-w4-preflight (C:4282–4284) and ai-w4-apply at the mutation boundary (C:4706–4708). Backup age must remain 0–1800s; stale at EITHER point STOPs, so no preflight proof can age past apply. No automatic second backup/drill; HezLead must authorize any revised sequence. U9/X2 staging evidence cannot satisfy production U7. [C:1781–1786; rulings 7,18–20,40–42] Acceptance: R-equal complete BK/helper layout and manifest, exactly two admitted drop-ins, unchanged Caddy/base units/hooks, one bound successful backup/drill, REAL integrity/isolation evidence and HezLead signature before U7/W4. Maker verification is source/citation inspection and syntax checks only; no service execution, restore, deployment, external contact or production measurement. [Rulings 7, 19, 40(4) amended]

# 03 — Keeper handoff and U9

Final source base: `2e2ac5e63e851cc84f345a65b3547de365e8ea2e` (2e2ac5e6). This fragment supplies H1(d), the ruling 11 re-install STOP, ruling 14 equality checks, and U9/item 17. Inputs are the install receipt, reviewed W4 inputs/baseline/plan, reviewed keeper bundle and INSTALL pins, and HezLead's staging dispatch. Outputs are nonsecret, window-bound handoff, retirement, recovery and U9 receipts. No operator command below was run during drafting. [Tasks F03–F03f; rulings 11–16, 40(6), 41, 43 with pins/addendum, 44–46] `C` means `docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md` at final R. `B` means `/Users/yulanbot/work/c1-frozen-resume/build-b`. `ARCH` means `/Users/yulanbot/work/c1-next/ARCHIVE-DURABLE-REPORT.md`. Placeholders such as `<MEASURED:receipt digest>` remain STOP inputs until the named owner records them. Reviewed source hashes are pins, not live measurements. [Task F03; C:82; B/PLAN.md §1b] `KIT` means `scripts/c1-staging-u9/` at final R, reviewed in 905610ffca8b77c6cd2d500cb2abc39b5a44d842 (Grok PASS part A r1/B r4/C r2), with K1 archive.py reviewed in 5a7ef2ca (Grok round 2 PASS) and merged at final R; its runtime dispatch is **not signed yet**. The source anchors are KIT/common.py:56–71, KIT/status.py:49–122, KIT/faults.py:33–59,100–132, KIT/archive.py:103–211, and KIT/README.md:16–119. `U9_KIT_DIR` names its verified, receipt-pinned upload on staging. STGGATE (reviewed 43c09b2a8cd0e027bae94e5509f7776f0ebcda01, in final R) is **the ruling-43 staging branch of ai-w1-backup-gate and ai-backup-gate-check**; dispatch must bind its reviewed plan bytes and digest. [Task F03c; rulings 41(4), 43(1); C:1749–1810,2212–2222,2236–2242]
## Keeper handoff

1. HezLead takes `ARCHIVE_KEEPER_HOST`, `ARCHIVE_KEEPER_UPLOAD_OWNER` and the printed section 1 `ARCHIVE_KEEPER_BASELINE` from `/Users/yulanbot/work/keeper-install-prod/REPORT.md`. Bind the U10 record and W4 inputs to that REPORT's freshly checked digest and install time. Do not transcribe its values into this fragment or the repository. Use the staging keeper's own install receipt for U9; never substitute the production receipt's host/baseline. [Rulings 13–16, 41; C:82, 4013–4016]
2. Keep `/root/recycle-archive-keeper` with its five payload files and `SHA256SUMS`, unchanged and checksum-matching, until W4. It supplies bundle bytes only; it contains no INSTALL.md. The W4 upload supplies `/tmp/admin-issuance-<R>-<window_id>-keeper-INSTALL.md`; check its whole-file hash before extracting any excerpt, then check all four excerpt pins. [Rulings 13, 15; C:4565, 4589–4599]
3. Measure U10 after the install receipt time: five installed files, three enable links, all three unit states, durable directories, ledger bytes/rows, every retained archive's bytes/metadata and the recycle drop-in. The helper is root:root 0700, three unit files root:root 0644, tmpfiles config root:root 0600; each regular payload has one link and equals the bundle. Directory/ancestor/link checks remain mandatory, including `/usr/local/libexec` root:root 0711 and the recycle service's drop-in directory root:root 0700. [C:4036–4038, 4561–4564; rulings 13, 39; B/PLAN.md:110]
4. On production, read `/root/keeper-install-20261010T165121Z.vars` as root on the box only. Require a regular, single-link, root:root 0600 file. Never copy it to the Mac, dump its declarations, or print its upload owner/bundle. Only BASELINE and HOST may be printed. U9 uses its staging install receipt's exact root-only VARS path. [Rulings 14, 16, 41; C:4617–4628]
5. Require receipt baseline == VARS baseline == the live three-file `sha256sum` result, with the same paths and order: `recycle.json`, recycle hook, then `50-admin-measurement.conf`. HOST in VARS must equal the receipt and live hostname. A1's config/hook/drop-in digests must equal these three baseline digests. Any inequality STOPs for HezLead inspection. [Ruling 14; C:4563, 4617–4628]
6. After `ai-w4-caddy-candidate`, before `ai-w4-apply` and any binding move, adopt only when binding digest == live bound legacy tar digest == keeper copy digest == its one ledger row digest. Require a quiet slot more than 900 seconds from 03:30, 09:30, 15:30 and 21:30 UTC. The recycle timer remains active and service inactive for retirement. [Rulings 1, 12, 14; C:4522, 4600–4615]
7. Run `ai-w4-keeper-retire` unchanged. It verifies INSTALL and the four excerpts, cross-checks VARS/live baseline, records adoption and attempt receipts, and runs pinned shell options, bundle preamble, quiet function and INSTALL §4 verbatim in ONE child shell. Never run INSTALL §1 inside W4. Cite the override exactly: “HezLead ruling 12 (2026-10-10): ruling 1 overrides INSTALL.md's 'no open release window' prose, for W4 only”. INSTALL.md remains unchanged. [Rulings 12, 14–15; C:4524–4525, 4589–4615, 4617–4650]
| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
| --- | --- | --- | --- | --- | --- |
| REPORT identity/time and HOST/UPLOAD_OWNER/BASELINE provenance: `<MEASURED:handoff>` | Fresh REPORT binding, U10 taken after install; inputs derived from REPORT (rulings 13–16; C:4013–4017) | HezLead; dispatched Codex worker records staging equivalent | Missing receipt, stale measurement, copied/guessed input | Signed U10 record; W4 `inputs.json`, `w4-state/recycle-baseline.json` | C:4520 `ai-w4-keeper-retire`, receipt/input equality |
| Bundle and five installed payloads: `<MEASURED:bytes and metadata>` | Five SHA256SUMS matches and exact root ownership/modes/one link; bundle retained (ruling 13; B/PLAN.md:110) | HezLead; staging worker for U9 | Any mismatch or unsafe path/ancestor | U10 record; `w4-state/recycle-baseline.json` | C:4520 pinned bundle excerpt and INSTALL §4 |
| Uploaded INSTALL/excerpts: `<MEASURED:digests>` | Whole file `48d914139cc0b853301fb497b2d3e5fef331ab02e4ec0dfda4b917b64dd23753`; shell_options 41–42, bundle 57–61, quiet 63–75, section4 516–599 pins (rulings 14–15; P:41–63) | HezLead; staging worker for U9 | Missing upload, changed file or excerpt; bundle INSTALL used | `keeper-INSTALL.md`, `keeper-retired.json` in `$PROOF_DIR` | C:4589–4599 checks whole file before excerpt extraction |
| Receipt == VARS == live baseline and HOST: `<MEASURED:equality>` | Exact three lines, same order; VARS regular/single-link/root:root 0600, host equality (ruling 14; C:4617–4628) | HezLead, on box only; staging worker on c1-staging only | Any inequality or unsafe VARS | Signed U10 and `keeper-adoption.json`; VARS stays on its box | C:4617–4628 then child-shell live recheck C:4631–4635 |
| Adoption/retirement: `<MEASURED:transition>` | Four equal archive digests; five files and three links absent; units not-found/inactive; durable state retained (rulings 1, 12; C:4615–4650, 4637–4647) | HezLead; staging worker for U9 | Wrong digest, partial retirement, state drift, quiet distance ≤900s | `keeper-adoption.json`, `keeper-retire-attempted.txt`, `keeper-retired.json` | C:4654 apply admission; C:5748 state/close validation |
| Re-install after recovered close: `<MEASURED:fresh receipt>` | Fresh INSTALL §§1–3, same reviewed bundle, quiet slot, new U10; “no reboot” until receipt (ruling 11) | HezLead signs STOP; dispatched release worker executes | No signed STOP/receipt, partial install, retry/reboot before receipt | New install receipt/VARS and signed U10; retained recovered-close/LOG | Fresh INSTALL §§1–3 and next W4 C:4013–4017/4510 |
| Timer recovery: `<MEASURED:admitted case>` | Only recorded C:5015 failure, or C:5051–5052 SIGKILL/host loss with bound window open, no apply alive and timer inactive; recovered shell re-defines step 8 reader (Task F03f; C:1638–1654, 5026–5052) | HezLead admits; dispatched release worker measures | Other name/case, uncertain process identity, missing signature/transcript/check or digest mismatch; never hand-start timer | Bound incident receipt with case, window, process checks and timer state; rollback transcript for recorded-failure | Reader rechecks exact failure line or open/no-close markers, signed no-apply measurement and live inactive timer; close still requires recovery proof |
## Operator commands and rollback handoff

8. In the already admitted root W4 session, use the following block reader to execute the exact reviewed plan bytes in that session. It checks `plan_sha256` each time, accepts only the names below and writes no executable discovery files. Common open/database-session and receipt inputs are prerequisites supplied by the assembled runbook; this helper does not grant target authority. [C:1638, 1822–1852, 5015, 5051–5052; W4 order C:346–365; ruling 40(6); Task F03f]
```text
set -euo pipefail
: "${PLAN_FILE:?}" "${INPUTS_FILE:?}" "${PROOF_DIR:?}"
c1_w4_block() {
  if test "$1" = ai-w4-timer-recovery; then
    case "${W4_TIMER_RECOVERY_CASE:-}" in
      recorded-failure)
        test -f "${W4_ROLLBACK_TRANSCRIPT:?receipt-bound rollback transcript required}" && test ! -L "$W4_ROLLBACK_TRANSCRIPT" || return 2
        grep -Fx 'FAIL timer recovery; window remains open; incident requires HezLead; STOP' "$W4_ROLLBACK_TRANSCRIPT" >/dev/null || return 2 ;;
      host-loss-sigkill)
        test "${W4_NO_APPLY_SIGNED:-}" = HezLead || return 2
        test -f "$PROOF_DIR/open.txt" && test ! -L "$PROOF_DIR/open.txt" || return 2
        test ! -e "$PROOF_DIR/closed.txt" && test ! -L "$PROOF_DIR/closed.txt" || return 2
        test "$(systemctl show "${EDGE_RECYCLE_TIMER:?}" --property=ActiveState --value)" = inactive || return 2 ;;
      *) printf 'STOP: unsupported timer-recovery case\n' >&2; return 2 ;;
    esac
  fi
  local c1_body
  c1_body=$(python3 - "$PLAN_FILE" "$INPUTS_FILE" "$1" <<'PY'
import hashlib,json,os,re,stat,sys; plan,inputs,step=sys.argv[1:]
allowed={'ai-w1-backup-gate','ai-w4-preflight','ai-w4-caddy-candidate',
         'ai-w4-keeper-retire','ai-w4-apply','ai-w4-probes','ai-w4-readback',
         'ai-w4-rollback','ai-w4-timer-recovery','ai-w4-state','ai-close'}
assert step in allowed, 'STOP: unsupported W4 block'
assert os.path.isabs(plan), 'STOP: plan path must be absolute'
fd=os.open(plan,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as f:
    assert stat.S_ISREG(os.fstat(f.fileno()).st_mode), 'STOP: plan not regular'; raw=f.read()
assert hashlib.sha256(raw).hexdigest()==json.load(open(inputs))['plan_sha256'], 'STOP: plan digest'
blocks=re.findall(r'^```sh\n(.*?)^```$',raw.decode(),re.M|re.S); marker=chr(35)+' step: '+step+'\n'
found=[b for b in blocks if b.startswith(marker)]
assert len(found)==1, 'STOP: block missing or duplicated'
sys.stdout.write(found[0])
PY
  ) || return 2
  printf '%s\n' "$c1_body" | /bin/bash -n || return 2
  eval "$c1_body"
}
```
9. Execute retirement after preflight/candidate and before apply. On production HezLead owns this step; on U9 HezLead is staging owner and his dispatched Codex release worker executes it. Do not invoke helpers with unsupported `ai_run` names. [C:1817, 4520; rulings 12, 14, 41]
```text
c1_w4_block ai-w4-preflight
c1_w4_block ai-w4-caddy-candidate; c1_w4_block ai-w4-keeper-retire
```
10. On W4 failure: rollback, conditional timer recovery, recovery probes/live controls and fresh receipts, then `CLOSE_RESULT=recovered` and `ai-close`. **If the shell was lost, first use ONE recovered root shell, the assembled runbook's `ai-recovery-env` and `ai-db-session` (never `ai-open`), then re-run step 8's COMPLETE fence to re-define `c1_w4_block` with the same digest-checked extraction before any call below.** The rollback EXIT guard must recover/verify the timer. Exactly two cases admit the timer-recovery fence: `recorded-failure`, with the exact C:5015 line in the bound rollback transcript; or `host-loss-sigkill`, when SIGKILL/host loss prevented the trap (C:5051–5052). For the latter, HezLead establishes the bound window is open (`open.txt` present, no `closed.txt`), no apply process is alive (host-side `pgrep` and `kill -0` against retained process identities; uncertainty STOPs), and the measured timer is inactive. Record those checks and the loss in the incident receipt, then set `W4_NO_APPLY_SIGNED=HezLead`; run the timer fence on reconnect **before rollback**. For a recorded rollback timer failure, run it **after that failure**. Set `W4_TIMER_RECOVERY_CASE` only from the admitted receipt. Every other name/case or failed rollback outcome STOPs; never start the timer by hand. Recovery grants no close claim; failed/UNKNOWN readback STOPs. No failure path re-installs the keeper. RETIRED close/LOG must say **“keeper retired; re-install required before reboot”**; retain durable state/ledger/archives/proof. INTACT requires exact baseline equality; partial state STOPs. [C:365–380, 1638–1654, 4885, 5014–5016, 5026–5052, 6204–6207, 9247–9249, 9353–9440; ruling 11; Task F03f]
```text
c1_w4_block ai-w4-rollback
```
In the recovered root session, with step 8 re-defined and HezLead's receipt admitting exactly one of those two cases, run at the stated point: [C:366, 373, 5015, 5026–5052; Task F03f]
```text
set -euo pipefail
test "${W4_TIMER_RECOVERY_ADMISSION:-}" = HezLead
c1_w4_block ai-w4-timer-recovery
```
11. After the assembled runbook's recovery controls have passed, close and verify the RETIRED phrase. If keeper classification is INTACT, retain that classification instead; do not claim retirement. [C:8914, 9247–9249; ruling 11]
```text
CLOSE_RESULT=recovered
c1_w4_block ai-close
if test "${W4_RECOVERED_KEEPER_CLASS:?set from verified recovered-state receipt}" = RETIRED; then
  grep -F 'keeper retired; re-install required before reboot' "$PROOF_DIR/W4-recovered-close.txt"
else
  test "$W4_RECOVERED_KEEPER_CLASS" = INTACT
fi
```
12. HezLead's checklist carries **“no reboot”** while the keeper is RETIRED. A HezLead-signed STOP authorizes fresh INSTALL §§1–3 from the same reviewed bundle in the next quiet slot, before any reboot or W4 retry. Check the pinned INSTALL whole-file hash, run §1 in a retained root shell, inspect its effective tmpfiles output as directed, then §§2–3 in that same shell. Use fresh receipt-sourced HOST/UPLOAD_OWNER and a fresh root 0600 VARS file; never reuse the old install baseline. Record the full install/verify outputs, install time and new receipt digest; take new U10 before releasing the STOP. A partial install stays STOPPED for inspection. [Ruling 11; B/PLAN.md §1e; reviewed INSTALL §§1–3, §3a]
The following commands run only under that signed re-install STOP, outside the closed W4, on the admitted host as root. `KEEPER_REINSTALL_MD` is the retained, reviewed INSTALL copy; it is not read from the bundle. `NEW_KEEPER_VARS` is a fresh exact root path named in the new install receipt. HOST/UPLOAD_OWNER below come from the already receipt-bound inputs; §1 computes a fresh BASELINE. Pause after §1 to inspect tmpfiles rules before running §§2–3. [Rulings 11, 13–15; reviewed INSTALL:41–172, 175–183, §§2–3]
```text
set -euo pipefail
test "$(id -u)" = 0
test "${KEEPER_REINSTALL_STOP_SIGNED:-}" = HezLead
: "${KEEPER_REINSTALL_MD:?}" "${NEW_KEEPER_VARS:?}" "${INPUTS_FILE:?}"
ARCHIVE_KEEPER_HOST=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keeper_host"])' "$INPUTS_FILE")
ARCHIVE_KEEPER_UPLOAD_OWNER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keeper_upload_owner"])' "$INPUTS_FILE")
test "$(hostname)" = "$ARCHIVE_KEEPER_HOST"
keeper_install_part() {
  local keeper_body
  keeper_body=$(python3 - "$KEEPER_REINSTALL_MD" "$1" <<'PY'
import hashlib,os,re,stat,sys; path,part=sys.argv[1:]; assert part in ('1','2','3')
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as f:
    assert stat.S_ISREG(os.fstat(f.fileno()).st_mode), 'STOP: INSTALL not regular'; raw=f.read()
assert hashlib.sha256(raw).hexdigest()=='48d914139cc0b853301fb497b2d3e5fef331ab02e4ec0dfda4b917b64dd23753', 'STOP: INSTALL digest'
section=raw.decode().split('## '+part+'. ',1)[1].split('\n## ',1)[0]
blocks=re.findall(r'^```bash\n(.*?)^```$',section,re.M|re.S); assert len(blocks)==1, 'STOP: install section block count'
sys.stdout.write(blocks[0])
PY
  ) || return 2
  printf '%s\n' "$keeper_body" | /bin/bash -n || return 2
  eval "$keeper_body"
}
keeper_install_part 1
```
After HezLead records that the printed tmpfiles rules meet INSTALL:175–183, save the fresh declarations on the box only, then install and verify. On any refusal preserve the file/state and STOP. [Rulings 11, 14; reviewed INSTALL §§1–3]
```text
test "${KEEPER_TMPFILES_REVIEW_SIGNED:-}" = HezLead
declare -p ARCHIVE_KEEPER_HOST ARCHIVE_KEEPER_BUNDLE ARCHIVE_KEEPER_UPLOAD_OWNER ARCHIVE_KEEPER_BASELINE |
  python3 -c 'import os,re,sys; p=sys.argv[1]; assert re.fullmatch(r"/root/keeper-install-[0-9]{8}T[0-9]{6}Z\.vars",p); fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600); os.fchmod(fd,0o600); os.fchown(fd,0,0); f=os.fdopen(fd,"wb"); f.write(sys.stdin.buffer.read()); f.flush(); os.fsync(f.fileno()); f.close()' "$NEW_KEEPER_VARS"
keeper_install_part 2
keeper_install_part 3
```

## W4X operator action under a held exclusion

These commands are for HezLead's authorized root W4 operator, using step 8's complete digest-checked `c1_w4_block` reader, the same bound inputs and persistent DB session. Take and terminal release are already called by C's preflight/close; do not add a separate take, hand-remove the record, or start the recycle service to clear the hold. On reconnect initialize the reviewed `ai-recovery-env` then `ai-db-session`, re-define step 8's reader, and retain the held exclusion. The independent alert remains live (C:4340–4349,9289–9294,9353–9359).

At the STOP ceiling/cap/unhealthy alert, HezLead records his response. Finish rollback/recovered close now, or run this reviewed rollback-aware recycle with the exclusion still held. It records a healthy restart without hooks or changed authority state and does not extend the exclusion's age cap (C:5904–5911,6083–6110,6209–6223):

```text
set -euo pipefail
test "${W4_HOLD_RESPONSE_SIGNED:-}" = HezLead
: "${PLAN_FILE:?}" "${INPUTS_FILE:?}" "${PROOF_DIR:?}"
W4_STATE_ACTION=rollback-recycle
c1_w4_block ai-w4-state
unset W4_STATE_ACTION
```

After any rollback, inspect the G6 receipt/live equality in the W4X row before recovered close. If C reports that a terminal record already exists but exclusion release is incomplete, use only its prescribed bound release retry; preserve the existing terminal records and receipt/state on refusal (C:6010–6033,6059–6076,9289–9294):

```text
set -euo pipefail
W4_STATE_ACTION=release
c1_w4_block ai-w4-state
unset W4_STATE_ACTION
```

## U9 — staging second W4

13. **Owner: HezLead. Executor: the Codex release worker HezLead dispatches.** Use c1-staging only, an independently verified root-owned STAGING-ONLY marker and staging endpoints. Start from the post-first-W4 `d518d4c9` shape with its legacy archive binding, compatibility hook/drop-in and keeper installed and verified; use full measured release identity, tree/image/mount evidence and staging install receipt, not a prefix as proof. Keep issuance CLOSED. No production connection or public production probe is permitted. Staging consent uses mock GitHub. [Rulings 40(5), 41; B/PLAN.md:109, §1e; ARCH:150; C:4025]
Measured baseline supplied by HezLead, read-only on **c1-staging-20261006** as ops: `commonswarm-postgres-backup.service` has `ExecStart=/bin/true`, no drop-ins, and its timer runs daily at **03:45 UTC**. Keeper units are enabled with ExecStart `/usr/local/libexec/commonswarm-recycle-archive keep` or `/usr/local/libexec/commonswarm-recycle-archive restore`. Edge recycle command: `docker restart --time 30 commonswarm-edge-edge-runtime-1`. **The staging stack release tree contains `deploy/supabase-stack/backup/run-backup.sh` at `<MEASURED:staging run-backup full release path>`, sha256 `<MEASURED:staging run-backup sha256>`; HezLead fills/adopts both and the full stack SHA `ad964ed158181ba1692dd05895f36fa7a1f87d3f`. The service is inactive.** Recheck source presence, exact path/hash and stub unit facts at dispatch; the baseline sha256 must equal that file in the exact stack SHA or STOP; the stub is not backup evidence. [Rulings 50, 54 amend 41; baseline only]
14. **Ruling 54: U9 NEVER runs `run-backup.sh` or `upload-snapshot.py`; nothing goes off-box.** Ruling 50 defines only the staging baseline above. U9's one backup follows the ruling 18/46 local path at R: online `dump-database.sh` through `backup_ro` into a fresh 0700 directory, then `restore-drill.py --local-artifact`, then the local status writer. Execute the existing guarded fences in steps 16–17 after the signed kit/identity admission; no second backup. Ruling 54 supersedes the earlier instruction to run the staging backup wrapper. [Rulings 18, 46, 54]

U9 gets **ONE fresh staging backup through ruling 18's path**: `deploy/supabase-stack/backup/dump-database.sh` at R, online via `backup_ro`, fresh 0700 directory/0600 files, then `restore-drill.py --local-artifact <MEASURED:abs dump dir>` (DRILL-LOCAL at final R, DRILL:47–56,481–494) within 60 minutes. Nothing goes off-box; never stop the live staging DB or mount its TLS key/env. **The local drill owns its container, internal network and TLS settings (`sslmode=disable`); no port is published and no fixture TLS is mounted for U9. Ruling 20's three X2 adaptations do not apply.** The drill runs `restore-target.sh`, `prepare-target.sh`, `restore-cron-jobs.sh`, `verify-counts.sh` in order and checks schema equality/counts including positive `commonswarm_ops.migration_checksums`. After U9/both-file remover, guarded removal of the exact dump precedes label-checked fallback container removal; the drill normally cleans its own labelled resources. U9 does not prove production U7. [Rulings 7, 17–18, 20 (X2 only), 41(2), 46, 54; BK/dump-database.sh:7–33 at final R; DRILL-LOCAL]
15. **Execution STOP until HezLead binds the final-R reviewed kit and signs its runtime receipt.** The available snapshot supplies `KIT/common.py` (guard and read-only identity probe), `KIT/status.py` (writer and both-file remover), `KIT/faults.py` (F1–F3), `KIT/archive.py` (ARCH §5 steps 1–3), and `KIT/README.md` (entry commands). Bind exact file digests, source-to-derived diffs, the final-R DRILL-LOCAL/STGGATE PASS reviews and signed receipt `<MEASURED:HezLead U9 kit receipt>` before dispatch. The files are available; review/signature remain STOP inputs. [Ruling 41(4); ruling 43 with addendum; ruling 44(1); KIT/README.md]
The exact status paths are **`/var/backups/commonswarm-postgres/status.json`** and **`/var/backups/commonswarm-postgres/restore-status.json`** (C:1776–1777 at final R). Ruling 43 corrects 41.3: U9 W4 uses **the ruling-43 staging branch of ai-w1-backup-gate and ai-backup-gate-check**, whose local form is exactly `destination: local-staging:<abs dir>`, `dump_sha256`, `drill: PASS`, `verified_at`, with the same freshness rule. `KIT/status.py` writes root:root 0600 status only after a real drill PASS; retain dump/SHA256SUMS digests, dump/restore/drill times and restore identity locally. The branch is selected ONLY by measured hostname **c1-staging-20261006 AND sha256(/etc/machine-id) = 29e448988c239181332e852c902c4c36815d628bb58cebc7da53c23f0f443565**, never env, flag, marker or operator input. The production negative-test pair is yulan-vps-1 / 6b63dad34fa7ced95e4f653aecb7e37ea7aa2a32902bdd593e23e93bb9877b22. Require review evidence that production output is byte-identical, production refuses local status/branch selection by input, and staging refuses an R2 destination it did not create. The stock gate cannot accept this local form. Do not fabricate upload claims, copy production status or overwrite unrelated status. The real drill owns restore-status.json; after its production, nothing edits or deletes it before the one both-file remover after U9. [Ruling 43(1), identity pins and addendum; C:1776–1810,2212–2220,2237–2242 at final R; KIT/common.py; KIT/status.py; KIT/README.md]
15A. **Controls 1–3 use `KIT/archive.py` and `KIT/README.md`; STOP until kit review PASS and HezLead's signature.** **The README's W4-session and reviewed `ai-recycle-hook` requirements (KIT/README.md:86–89 at final R) are superseded by rulings 53(b)/(c) and K1's legacy-hook pin/exclusion refusal below.** Run them in their **OWN admitted staging step BEFORE any W4X exclusion is taken and BEFORE A1**, using the Window admission fence above, dedicated case/input/proof bindings and independent receipts. Establish only the reviewed root/`ai_ro` session (C:1638–1702), not the W4 preflight/open/take that installs the exclusion. Retain independent CLOSED readback, legacy binding, equal durable rescue and no overlapping Part B/PostgREST window. **K1 at final R pins `KIT/archive.py`'s expected legacy hook to measured live `3f03038e7dde0e6402f3359f4abcf5815d847ca3d7fefcefa8ec0e31c7a5b5e6` (KIT/archive.py:26,123–124); never preinstall the upgraded hook. Every archive.py CLI action checks before context/service observation or mutation that neither `/var/lib/commonswarm-admin-release/w4-exclusion.json` nor `/usr/local/lib/systemd/system/commonswarm-edge-recycle.service.d/00-w4-exclusion.conf` exists (KIT/archive.py:246–249). The K1 final-R source pin is resolved; its commit records the independent Grok round-2 PASS. Source tests cover upgraded-hook refusal and the measured legacy positive (tests/p1-cli/c1-staging-u9.test.ts:382–387), plus refusal for all actions/phases with each exclusion path alone as regular, symlink and dangling symlink (tests/p1-cli/c1-staging-u9.test.ts:420–437). K1c ignores Linux read/traversal atime while the refusal check keeps mode, inode, device, links, owner, group, size, mtime, ctime and bytes. The successful unblocked `phase('before')` retry and its aside/snapshot/timer checks are at tests/p1-cli/c1-staging-u9.test.ts:484–486; these tests were read, not run by this drafting worker. Runtime kit/signature admission remains required.** Ruling 45 remains binding: never remove the exclusion or hand-start around it. Control 1: record hook/config/tar digests and metadata, resolved trees, edge StartedAt, timer/service state and safe cutover projection. With legacy binding/tar present, manually run recycle and require success using the compatibility hook. [ARCH:150–154; B/PLAN.md §1g item 17; rulings 41(4), 44(1); KIT/archive.py; KIT/README.md]
15B. Control 2: with timer held and independent CLOSED readback, preserve exact legacy JSON and move only the identified legacy tar to a checked task-owned aside path; retain durable rescue. Leave legacy binding; invoke the real service. Require nonzero archive-validation failure at ExecStartPre, UNKNOWN hook message, no restart/StartedAt change, then independently confirm DB CLOSED. A failed readback is UNKNOWN/STOP. [ARCH:155; ruling 41(4); KIT/archive.py; KIT/README.md]
15C. Control 3: restore the tar and byte-identical legacy JSON. Record failure before the reviewed driver resets the failed-unit state. Run the service again and require success. This positive recovery control must follow the archive-loss negative. [ARCH:156; ruling 41(4); KIT/archive.py; KIT/README.md]
After 15C, retain all `u9-ARCH-*.json` control receipts, byte/digest/metadata equality and recovered active timer/inactive service/CLOSED readback. HezLead signs this standalone step's admission/control/completion receipts before its session closes. Only then proceed to the one U9 backup/drill and later case-specific W4 admission → W4X take → A1. The common W4 preflight is not a prerequisite for these standalone controls. Do not repeat these manual service controls inside a held W4. [Ruling 53(c)]

16. **Before ANY step-16 action, run the SAME Window admission fence above for the separate U9 dump/drill/status step (ruling 53(a)). Both its planned open and planned end must PASS before step 16 starts; the end must be strictly before the next 03/09/15/21:30Z recycle slot.** Bind the fresh admission receipt to final R, measured staging host, dedicated case/input/proof and the full steps 16–17 duration; retain its digest in HezLead's signed step receipt. The kit runs neither dump nor drill. After step 15 is signed, HezLead checks BOTH identity pins. **(a) Run this self-contained U9 dump fence once**, using the verified full-R tree and exact staging 0600 env path; only the tool reads backup_ro credentials on staging. It binds the fresh directory before dumping and records its identity, exact SHA256SUMS/sha256 and UTC completion outside the dump. Any non-zero exit, existing receipt or unexpected directory/file state STOPs; retain partial state, never repeat the backup. **Never run F04 operator.py's prepare or finally, or any X2 variant on c1-staging under U9.** PG17/node/CA and backup_ro identity checks come from the R tool; F02 supplies the reviewed R payload. [Rulings 18, 41(2,4–5), 43 pins, 46, 54; BK/dump-database.sh:7–33 and make-backup-service.mjs:4–23 at final R; KIT/common.py; KIT/status.py; F02 §§1–3]
```text
set -euo pipefail
umask 077; test "$(id -u)" = 0
test "$(hostname)" = "${U9_STAGING_HOST:?signed staging dispatch required}"
test "${U9_KIT_REVIEW_SIGNED:-}" = HezLead
: "${U9_REPO_R:?verified full R tree with DRILL-LOCAL required}" "${U9_RELEASE_SHA:?signed full R required}" "${U9_STAGING_ENV:?exact staging env path required}" "${U9_KIT_DIR:?}" "${PROOF_DIR:?}"
python3 "$U9_KIT_DIR/common.py" check >"$PROOF_DIR/u9-identity-probe.json"
python3 "$U9_KIT_DIR/status.py" before "$PROOF_DIR/u9-before-drill.json"
U9_DUMP_DIR=$(python3 - "$U9_KIT_DIR" "$U9_REPO_R" "$U9_RELEASE_SHA" "$U9_STAGING_ENV" "$PROOF_DIR" <<'PY'
import json,os,pathlib as p,re,secrets,stat,subprocess as sp,sys; sys.path.insert(0,sys.argv[1]); from common import canonical,digest,directory,guard,now,read,write
root=p.Path(canonical(sys.argv[2])); release=sys.argv[3]; env=p.Path(canonical(sys.argv[4])); proof=p.Path(canonical(sys.argv[5])); identity=guard()
directory(proof); base=p.Path(canonical('/var/backups/commonswarm-postgres'))
for parent in (base,*base.parents):
    s=parent.lstat(); assert stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and not s.st_mode&0o022, 'STOP: unsafe dump ancestor'
assert re.fullmatch('[0-9a-f]{40}',release) and sp.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()==release, 'STOP: R identity'
sp.run(['git','-C',str(root),'diff','--quiet','HEAD','--'],check=True)
s=env.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600, 'STOP: staging env'
assert not any(os.path.lexists(proof/n) for n in ('u9-dump-started.json','u9-dump.json','u9-dump.log')), 'STOP: no second backup'
dump=base/('u9-'+secrets.token_hex(16)); assert not os.path.lexists(dump), 'STOP: dump path exists'
row=dict(kind='c1-u9-dump',identity=identity,release_sha=release,directory=str(dump))
write(proof/'u9-dump-started.json',row)
child=os.environ.copy(); child['COMMONSWARM_ENV_FILE']=str(env)
fd=os.open(proof/'u9-dump.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as log: sp.run(['bash',str(root/'deploy/supabase-stack/backup/dump-database.sh'),str(dump)],env=child,stdout=log,stderr=sp.STDOUT,check=True)
completed=now().isoformat(); directory(dump)
for path in dump.rglob('*'):
    s=path.lstat(); assert s.st_uid==s.st_gid==0 and (stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700 or stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600), 'STOP: dump metadata/type'
names='database.dump roles.sql manifest.txt source-counts.tsv storage-objects.ndjson cron-jobs.ndjson globals.sql storage-backend-objects.ndjson'.split()
def sha(path):
    import hashlib; h=hashlib.sha256()
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
        for chunk in iter(lambda:f.read(1048576),b''): h.update(chunk)
    return h.hexdigest()
raw=read(dump/'SHA256SUMS'); lines=raw.decode().splitlines(); assert len(lines)==8, 'STOP: SHA256SUMS count'
for line,name in zip(lines,names): assert line==sha(dump/name)+'  '+name, 'STOP: dump checksum/name'
s=dump.lstat(); bound=f'{s.st_dev}:{s.st_ino}:{s.st_uid}:{s.st_gid}:{stat.S_IMODE(s.st_mode):o}'; row.update(dump_completed_at=completed,directory_id=bound,SHA256SUMS=raw.decode(),sha256sums_sha256=digest(raw),dump_sha256=sha(dump/'database.dump'))
write(proof/'u9-dump.json',row); print(dump)
PY
)
U9_DUMP_COMPLETED_AT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dump_completed_at"])' "$PROOF_DIR/u9-dump.json")
U9_CREATED_DUMP_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["directory_id"])' "$PROOF_DIR/u9-dump.json")
readonly U9_CREATED_DUMP_DIR="$U9_DUMP_DIR" U9_CREATED_DUMP_ID
```
17. **(b) Run DRILL-LOCAL, then (c) the status writer under step 16's SAME admitted open/end, then U9 under its separate case admission.** Dump, drill and status must finish before that admitted end and the next recycle :30; no overrun is admitted. Retain completion evidence and HezLead's signed close receipt before any W4 case opens. Before exec, STOP unless the R drill file's sha256 is **1f8e5c4b12dfe9a1f11cdb67e622b4c6d1223a7b9235d466185e6ae0dd1d9786** AND its bytes contain `--local-artifact`: the reviewed DRILL-LOCAL in final R, including the staging guard (DRILL:47–56,481–494). HEAD equality alone cannot admit it. HezLead re-pins this digest if the reviewed file changes before release. Record `drill_file_sha256` in `u9-local-drill.json`. DRILL-LOCAL runs the four tools/ruling-42 proof with label-scoped cleanup. Require age 0–3600s before start, exit 0 and every proof/local-scope field; missing fields STOP. `ok=true` proves database restore only. Retain the drill label before gate removal. Status admission remains 0–1800s; never refresh its time. **Expiry before U9 ends = STOP + new HezLead ruling; no second backup.** Both gate files stay unchanged until (d). [Rulings 18, 41(5), 42, 43/addendum, 46; DRILL-LOCAL (review/signature STOP); Task F03f; KIT/status.py; C:1778–2220, 1802–1810, 4706–4709 at final R]
```text
set -euo pipefail
python3 -c 'import hashlib,json,os,sys; r=json.load(open(sys.argv[1])); assert r["directory"]==sys.argv[2]==os.path.realpath(sys.argv[2]), "STOP: dump receipt path"; assert hashlib.sha256(open(sys.argv[2]+"/SHA256SUMS","rb").read()).hexdigest()==r["sha256sums_sha256"], "STOP: dump receipt manifest"' "$PROOF_DIR/u9-dump.json" "$U9_DUMP_DIR"
python3 -c 'import datetime as d,sys; age=(d.datetime.now(d.timezone.utc)-d.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))).total_seconds(); assert 0<=age<=3600, "STOP: dump age"' "$U9_DUMP_COMPLETED_AT"
python3 - "$U9_REPO_R/deploy/supabase-stack/backup/restore-drill.py" "$U9_DUMP_DIR" <<'PY' >"$PROOF_DIR/u9-local-drill.json"
import hashlib,json,os,stat,subprocess as sp,sys; path,dump=sys.argv[1:]
with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as f:
    assert stat.S_ISREG(os.fstat(f.fileno()).st_mode), 'STOP: drill not regular'; raw=f.read()
sha=hashlib.sha256(raw).hexdigest(); assert sha=='1f8e5c4b12dfe9a1f11cdb67e622b4c6d1223a7b9235d466185e6ae0dd1d9786' and b'--local-artifact' in raw, 'STOP: DRILL-LOCAL digest/flag'
result=json.loads(sp.check_output(['python3',path,'--local-artifact',dump],text=True))
result['drill_file_sha256']=sha; print(json.dumps(result,sort_keys=True))
PY
U9_DRILL_LABEL=$(python3 - "$U9_DUMP_DIR" <<'PY'
import json,re,sys; s=json.load(open('/var/backups/commonswarm-postgres/restore-status.json'))
assert s['ok'] is True and s['state']=='complete' and s['status']=='PASS' and s['at']
assert s['source']=='local-staging:'+sys.argv[1] and s['objects']=='not-in-local-dump' and s['scope']=='database-only'
assert s['restore_container_id'] and s['database']=='postgres' and s['restored_at'] and s['schema_checksums']['source']==s['schema_checksums']['target'] and s['schema_checksums']['algorithm']=='sha256-schema-ddl-v3'
assert s['key_table_counts'] and all(c['source']==c['target'] for c in s['key_table_counts'].values()) and s['key_table_counts']['commonswarm_ops.migration_checksums']['target']>0
assert re.fullmatch(r'commonswarm\.drill=[0-9a-f]{32}',s['label']); print(s['label'])
PY
)
readonly U9_DRILL_LABEL; python3 "$U9_KIT_DIR/status.py" write "$PROOF_DIR/u9-status-written.json" --dump-dir "$U9_DUMP_DIR" --source-receipt "$PROOF_DIR/u9-before-drill.json"
```
18. **Require completed standalone ARCH 15A–15C receipts; run the Window admission fence before this case opens, then take W4X exclusion before A1.** For each success/failure case, measure a fresh pre-attempt snapshot and install/verify the keeper before opening its W4. Bind inputs/receipts to R, staging host, case and unique window. Execute the existing common W4 preflight/open/session and the reviewed U9 backup gate, then steps 8–9. Exercise BASELINE/VARS/live mismatch, INSTALL/excerpt mismatch, adoption digest mismatch and both sides of the quiet boundary; each must refuse before mutation. Restore the admitted state before another case. [Rulings 11–15, 41; C:346–365, 4520–4650; B/PLAN.md §1g item 18]
19. Success case: retirement completes before apply; apply reaches R, upgrades the hook, preserves the admitted drop-in and binds the durable archive. Run `ai-w4-probes`, `ai-w4-readback`, ordinary after-controls and success close. The manual service controls are proved only by standalone 15A–15C before exclusion; no manual service activation under W4X counts as those controls. Under exclusion, use only the reviewed rollback-aware action when required by HezLead, retaining healthy edge, intended target/image/mounts, generation/binding/CLOSED readback and before/after container ID/StartedAt. Never release or bypass the exclusion to obtain a manual-control PASS. This does not claim ARCH step 4's recycle without /tmp tars; steps 4–5 are cut under step 25. [C:4654, 4819, 4872, 9122–9124; B/PLAN.md §1g item 17; ARCH §5 steps 1, 4 (cut); ruling 44(1); KIT/archive.py; KIT/README.md]
```text
c1_w4_block ai-w4-apply
c1_w4_block ai-w4-probes
c1_w4_block ai-w4-readback
```
After the assembled runbook's ordinary after-controls produce the admitted after receipts, run the success close. [C:8914, 9122–9124]
```text
CLOSE_RESULT=success
c1_w4_block ai-close
```
20. Run staging F1, F2 and F3 through `KIT/faults.py` and `KIT/README.md`, at the exact boundaries below; no production test hooks and no blanket success handling of failure commands. The source plan has no native fault switch: `KIT/faults.py` supplies the injection diffs and exact drivers. **STOP until cross-family PASS and HezLead's signed kit receipt.** Retain each intended fault, rollback/recovered close and comparison of all three sets below. Re-install under step 12 before the next W4 case. [Rulings 11, 41(4), 43(3); B/PLAN.md §1g items 24–26; KIT/faults.py; KIT/README.md]
| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
| --- | --- | --- | --- | --- | --- |
| Staging baseline: `<MEASURED:dispatch recheck>` | Inactive stub /bin/true, daily 03:45 UTC/no drop-ins; enabled keep/restore; measured edge restart; run-backup.sh PRESENT in measured ad964ed158181ba1692dd05895f36fa7a1f87d3f release tree, path/hash owned by HezLead (rulings 50, 54; baseline only) | HezLead's dispatched Codex release worker | Baseline drift or stub counted as backup | Local U9 baseline/kit receipt | Live units/drop-ins/timer/command and source presence/path/hash equality at the exact stack SHA before backup/W4; U9 local-only backup in steps 16–17 |
| Identity-probe: `<MEASURED:hostname, machine-id sha256, UTC time>` | c1-staging-20261006 AND 29e448988c239181332e852c902c4c36815d628bb58cebc7da53c23f0f443565 (ruling 43 pins; KIT/common.py identity) | HezLead | Missing measurement or either pin mismatch | Signed dispatch's retained read-only identity-probe receipt | KIT/common.py check/guard and measured identity at both staging gate blocks; no input override |
| U9 kit: `<MEASURED:file digests, PASS, signature>` | KIT/common.py, status.py, faults.py, archive.py and README.md plus DRILL-LOCAL/STGGATE reviewed and signed; ARCH 1–3 only (rulings 41(4), 43, 44) | HezLead signs; dispatched Codex release worker verifies | Missing kit pin, review PASS or HezLead signature | Signed U9 kit receipt and source-to-derived diffs | Rehash exact kit/drivers and verify receipt before each case |
| U9 backup/status: `<MEASURED:one dump, drill, status>` | R/backup_ro dump; fresh 0700/0600; drill within 3600s; no off-box/port/fixture TLS; local-staging:<dir>/objects not-in-local-dump/scope database-only restore status; root 0600 status.json exactly destination local-staging:<abs dir>, dump_sha256, drill PASS, verified_at (rulings 18, 43(1), 46; DRILL-LOCAL aa386f6e digest/--local-artifact pin (step 17; Task F03f); C:1776; KIT/status.py) | HezLead's dispatched Codex release worker | Drill digest/flag mismatch, non-zero dump/drill exit, unexpected directory state, unsigned kit, missing/false provenance, stale/foreign status, identity mismatch or second backup; expiry needs new ruling | u9-dump-started.json and u9-dump.json bind exact directory/identity/SHA256SUMS/digests/time; u9-local-drill.json includes drill_file_sha256; c1-staging gate/drill proof; U9 receipt | Exact drill digest/flag before exec, exact dump receipt equality before drill/cleanup; ruling-43 staging branch at open, apply C:4706–4709 and close |
| U9 success: `<MEASURED:keeper→durable→recycle>` | Installed keeper → equal-digest adoption → retirement → binding move → successful recycle (C:4520, 4654; ARCH §5) | HezLead's dispatched Codex release worker | Unsigned kit, reordered/partial transition, missing archive, bad recycle/health/CLOSED readback | `$PROOF_DIR` adoption/retirement/measurement/close receipts and U9 transcript | C:4872 readback; C:5748 state; success close C:9122–9124 |
| F1 recovery: `<MEASURED:before switch>` | Fault after CLOSED/invalidation, attempt marker, timer hold and recheck; before `ln -sfT` (C:4710–4720; PLAN §1g item 24) | HezLead's dispatched Codex release worker | Unsigned kit, wrong boundary, absent fault, restoration-set mismatch | F1 proof/LOG, rollback measurement, recovered close, snapshots/diff | C:4885 rollback, C:5748 recovered-state check in C:9247–9249 |
| F2 recovery: `<MEASURED:after recreate/health>` | Fault after compose recreate/health and edge-measurement.json writer C:4726–4744; insertion before comment C:4746, measure.sql C:4767 and Caddy install C:4807 (PLAN §1g item 25; KIT/faults.py at final R source boundary) | HezLead's dispatched Codex release worker | Unsigned kit, wrong boundary, missing healthy proof, restoration-set mismatch | F2 proof/LOG, rollback measurement, recovered close, snapshots/diff | C:4885 and recovered close C:9247–9249 |
| F3 recovery: `<MEASURED:after recycle install>` | Fault immediately after `RECYCLE_INSTALL_ACTION=install; ai_run ai-recycle-install` completes (C:4811–4812; C:4813 is the later apply printf; PLAN §1g item 26) | HezLead's dispatched Codex release worker | Unsigned kit, producer not completed, wrong boundary, changed drop-in or set mismatch | F3 proof/LOG, promoted-archive receipt, rollback measurement, recovered close, snapshots/diff | C:5569 recycle rollback; C:5748 and recovered close |
| ARCH controls 1–3: `<MEASURED:service failures and recovery>` | KIT/archive.py positive/loss/restoration controls in standalone 15A–15C BEFORE exclusion/A1, own Window admission/control/completion receipts; measured legacy hook pin and K1 refusal required; active timer and independent CLOSED readback (ARCH §5 steps 1–3; rulings 41(4), 44(1); KIT/README.md) | HezLead's dispatched Codex release worker | Unsigned kit, negative fails elsewhere, unexpected restart, UNKNOWN/readback failure, missing rescue/restoration | Three labelled control transcripts, status/StartedAt/digest projections, U9 receipt | KIT/archive.py guard/context and C:4872,5748 readback/state; manual recycle status/readback |
| ARCH steps 4–5: recorded cut | CUT from U9; reason: no live proof of a durable recycle without the /tmp tars, and none of rescue restaging plus a byte-identical rollback. (ruling 44(1); ARCH:157–160; FOLLOW-UPS-C1.md #51–#53) | HezLead | Cut controls run or claimed PASS; production W4 without reviewed W4X in dispatched runbook | Signed U9 cut/reason; ASSESS-l5-W4RB.md YES, Grok PASS; reviewed W4X binding; #53 remains after C1 | Steps 4–5 excluded; production W4 STOPs until this reviewed runbook is dispatched plus Tom's alert step; #51/#52 fixed in final-R W4X; #53 after C1 |
| W4X U9: `<MEASURED:exclusion/hold/rollback/terminal receipts>` | Final R W4X is reviewed; use the same take-before-A1, 1536 MiB/6 h alert, rollback-aware recycle and baseline-approval/terminal-only-release checks as production. U9 still requires its signed staging dispatch and dedicated alert delivery precondition (ruling 45; C:4340–4349,5851–5857,5904–5946,6010–6033,6082–6110,9285–9297) | HezLead dispatches/signs; Codex release worker executes staging only | Missing dedicated alert config/channel, unsigned dispatch, exclusion absent/foreign, silent skip, hold alert missing, rollback receipt/approval drift, premature release or missing terminal proof | U9 case receipts plus w4-exclusion-taken.json, w4-baseline-approval.json when rollback runs, close-result.json, closed.txt and w4-exclusion-released.json | Recheck final-R plan/notifier pins; take before A1; check hold after reconnect; retain exclusion through rollback; verify release only after success/recovered terminal record |
| W4X U9 alert prerequisite: `<MEASURED:staging dedicated alert receipt>` | Production Tom step above is a STOP prerequisite for production W4. U9 must independently admit the same root:root 0600 `/etc/commonswarm-admin-release/w4-healthcheck.env` and R-bound notifier/channel before its take; HezLead signs staging delivery proof and keeps production capability values off staging (C:5851–5878,5972–6007) | Tom supplies the dedicated check; HezLead admits/dispatched staging worker records | Missing dedicated check/config/initial delivery, production capability copied, invalid metadata or unsigned dispatch | Signed staging alert prerequisite and case take receipt, no URL | Same C preflight/notifier checks; no identity flag or status stub waives them |
| W4X U9 take/terminal release: `<MEASURED:case exclusion receipts>` | Each case takes exclusion before A1, survives reconnect/reboot, releases only after bound durable success/recovered terminal records; EXIT re-arm retains it (C:4340–4349,6010–6058,9285–9297) | HezLead/release worker | Missing take, foreign record, early release or terminal mismatch | Case w4-exclusion-taken.json, close-result.json, closed.txt, w4-exclusion-released.json | Recheck exclusion/admission before case; terminal-only release after case recovery |
| W4X U9 bounded hold/action: `<MEASURED:skip/alert/recycle receipt>` | 1536 MiB and 6 h record/restart cap; every skip journals window/age; independent 5 min alert `/fail` retains exclusion. HezLead action is reviewed rollback-aware recycle or prompt recovered close; no service hooks/authority writes (C:5863–5868,5904–5947,6083–6110,6209–6223) | HezLead responds; staging worker records | Silent skip, absent/stale alert, limit mismatch, missing restart proof or auto-release | Case alert/journal and rollback-aware/pending receipt | Host check persists after release-shell loss; new healthy StartedAt, intent/generation/invalidation/provenance unchanged |
| W4X U9 G6 rollback approval: `<MEASURED:baseline/live approval equality>` | Fresh window-bound w4-baseline-approval.json after rollback; baseline archive/tree/mount/image + live approval/measurement equal while CLOSED/invalidated and higher generation; rechecked at recovered release (C:4917–4999,6014–6025) | HezLead/release worker | Missing receipt, drifted approval/binding/measurement or wrong generation | Case baseline-approval and rollback-measurement receipts | Reconcile before any post-rollback recycle/recovered exclusion release; exact RESTORED/RETAINED/RETIRED sets still decide close |
| U9 cleanup: `<MEASURED:both gate hashes, sizes, mtimes and absences>` | ONE KIT/status.py remove step, U9_GUARDED_RM only; status.json and restore-status.json sha256/size/mtime before, both absent after; restore status unchanged until then (ruling 43 addendum; KIT/status.py; KIT/README.md) | HezLead's dispatched Codex release worker; HezLead signs completion | Missing/changed writer binding, pre-removal restore edit/deletion, guard refusal or either path remains | u9-status-removed.json.before and u9-status-removed.json; original writer/before-drill receipts retained | KIT/status.py remove checks identity and both files before deleting either; verifies absence after each guard call |
## Exact U9 recovery acceptance sets

21. Compare every monitored entry with its pre-attempt snapshot: paths/types, bytes/digests and uid/gid/mode, symlink targets and recorded absence. Roots are `/etc/commonswarm-admin-release/`, `/usr/local/libexec/`, recycle/keeper units, their drop-in directory and systemd wants links, keeper tmpfiles config, `/etc/caddy/`, edge current/releases/failed-attempts, helper releases, durable state, and the exact admitted legacy/R tar and W4 INSTALL upload paths. Use exact task identities for `/tmp` entries, never a glob. Record `/home/commonswarm/.env` digest/metadata without printing contents; TLS material is metadata-only. Every object outside the permitted sets must equal its snapshot. [B/PLAN.md §1e; C:5772–5800; rulings 14, 39]
**RESTORED — exact baseline bytes/metadata or recorded absence:** [B/PLAN.md §1e; C:6165–6202]

- Edge current → baseline release; running baseline image; `.env` bytes.
- All three Caddy files: API site, MCP site and Caddyfile.
- Recycle hook, `recycle.json`, drop-in and its directory, `recycle-intent.json` or absence.
- Recycle timer enabled/active; service inactive; both unit-file bytes.
- Bound legacy tar, restaged from the equal durable rescue copy only if missing; baseline helper and edge tree manifests.
- Durable state directory metadata, ledger bytes and every pre-existing archive's name/bytes/metadata, including the adopted keeper copy. F3's newly created R archive is allowed residue, not baseline history.
**RETAINED — only window-owned permitted residue:** [B/PLAN.md §1e; C:6169–6176]

- `$PROOF_DIR`: attempt markers, edge-aside, snapshots, receipts and fresh measurement; A1/A6 per-window proof storage.
- Root:root 0700 failed-attempts directory and this window's `<R>-W4-<window_id>` edge tree.
- R helper tree, exact R tar upload, W4 INSTALL upload and `$PROOF_DIR/keeper-INSTALL.md`.
- Only newly created durable R tar (F3) and any window-created rescue copy; no pre-existing archive changed/removed.
- Singleton CLOSED, newer invalidation and higher release generation, fresh measurement receipt. Never restore an old generation.

**RETIRED — only after completed retirement:** [B/PLAN.md §1e; C:4560–4563, 4643–4650, 6163–6181; ruling 11]

- Five payload paths: `/usr/local/libexec/commonswarm-recycle-archive`; keep.service, keep.timer and restore.service under `/etc/systemd/system/`; `/etc/tmpfiles.d/commonswarm-recycle-archive.conf`: all absent.
- Three enable links: timers.target.wants/keep.timer and multi-user.target.wants/keep.service and restore.service: absent.
- The three keeper units are not-found and inactive; durable state remains as required by RESTORED.
- If retirement never removed anything, require exact INTACT baseline files/links/units. Mixed state refuses recovered close and STOPs for HezLead inspection. RETIRED close carries the ruling 11 phrase and “no reboot” STOP.
## ARCH disposition and U9 cleanup (controls ran in standalone 15A–15C)

25. ARCH section 5 steps 4–5 are **CUT from U9**, as recorded in the table; do not execute them or claim their proof. The cut reason is exactly: **no live proof of a durable recycle without the /tmp tars, and none of rescue restaging plus a byte-identical rollback.** No host reboot is required or authorized by U9. Preserve uncertain outcomes as incidents. [Ruling 44(1); ARCH:157–160; C:4872, 5748; ruling 11]
26. The ruling-44 assessment **ASSESS-l5-W4RB.md answered YES; Grok PASS**: rollback/recovered close can be needed after a recycle. By ruling 45, **#51/G5 and #52/G6 are fixed in code by reviewed W4X at final R. Production W4 still STOPs until this runbook is reviewed/dispatched and Tom has completed the dedicated W4 alert step.** U9 exercises the same exclusion/hold/rollback/terminal checks under its signed staging dispatch, as the W4X row records (C:4340–4349,4973–4999,5851–5857,6010–6033,9285–9297). **#53/G3/G4/G7/G8 stay after C1**; the U9 cut supplies no proof for #51/G5/#52/G6; their code fix is W4X and their remaining execution prerequisites are below. The FOLLOW-UPS GATE line's “Grok review running” is superseded by its PASS review and ruling 45. [Rulings 44(2–3), 45; B/dispatch/ASSESS-l5-W4RB.md; /Users/yulanbot/work/c1-frozen-resume/detached/REVIEW-l5-W4RB-grok.txt; /Users/yulanbot/work/c1-verify/review/FOLLOW-UPS-C1.md #51–#53 and GATE status]
27. After all U9 cases, HezLead signs the staging receipt with R, staging identity, each window/case, signed kit file digests and writer/injection/driver diffs, before/after manifests, measured results, cut reason and evidence pointers. Preserve local dump sha256, drill PASS, UTC provenance and final status binding. Run **(d) ONE `KIT/status.py remove` step** to remove BOTH `/var/backups/commonswarm-postgres/status.json` and `/var/backups/commonswarm-postgres/restore-status.json` through `U9_GUARDED_RM`, recording each sha256, size and mtime before and absence after. Nothing edits or deletes restore-status.json before that step. Retain the writer's post-drill hash; any change STOPs. **Then (e) remove exactly the dump directory created by (a), checking its path and device/inode/owner/mode binding; (f) use the retained drill label for checked fallback container cleanup.** Normally DRILL-LOCAL already removed its labelled container; an empty label listing is success. Preserve proof receipts outside the dump. A mismatch STOPs before deletion. A refusal retains the before-removal receipt and remaining files and is reported as `BLOCKED by rm guard: "<refusal>". To resolve: HezLead reviews the exact retained path.` [Rulings 40(6), 43 addendum; WORKER-RULES.md Reporting/Deleting files; KIT/status.py; KIT/README.md; rulings 18, 46; DRILL-LOCAL]
```text
set -euo pipefail
test "$(id -u)" = 0
test "$(hostname)" = "${U9_STAGING_HOST:?hostname bound to signed staging dispatch required}"
test "${U9_COMPLETE_SIGNED:-}" = HezLead
: "${U9_KIT_DIR:?verified receipt-pinned kit upload required}" "${PROOF_DIR:?}"
: "${U9_GUARDED_RM:?HezLead-verified installed guarded rm path required}"
export U9_GUARDED_RM
python3 "$U9_KIT_DIR/status.py" remove "$PROOF_DIR/u9-status-removed.json" --source-receipt "$PROOF_DIR/u9-status-written.json"
test "$U9_DUMP_DIR" = "$U9_CREATED_DUMP_DIR"
test -d "$U9_DUMP_DIR"; test ! -L "$U9_DUMP_DIR"
test "$(stat -c '%d:%i:%u:%g:%a' -- "$U9_DUMP_DIR")" = "$U9_CREATED_DUMP_ID"
"$U9_GUARDED_RM" -r -- "$U9_DUMP_DIR"
test ! -e "$U9_DUMP_DIR"; test ! -L "$U9_DUMP_DIR"
python3 - "$U9_DRILL_LABEL" <<'PY'
import json,re,subprocess as sp,sys
label=sys.argv[1]; assert re.fullmatch(r'commonswarm\.drill=[0-9a-f]{32}',label)
listing=['docker','ps','-aq','--filter','label='+label]
for cid in sp.check_output(listing,text=True).splitlines():
    c=json.loads(sp.check_output(['docker','container','inspect',cid],text=True))[0]
    assert c['Config']['Labels']['commonswarm.drill']==label.split('=',1)[1] and c['Id'].startswith(cid), 'STOP: drill label mismatch'
    sp.run(['docker','rm','-fv',c['Id']],check=True)
assert not sp.check_output(listing,text=True).strip(), 'STOP: owned drill container remains'
PY
```
Acceptance for this fragment: handoff sources, equality STOPs, retirement ordering, rollback/no-reboot/fresh re-install, U9 owner/stub baseline/one-dump authority, kit review/signature STOP, measured identity/local gate form/expiry, both-file remover then exact guarded dump removal/label-checked container fallback, local drill fields/exit STOP, F1–F3 full sets, ARCH controls 1–3 and recorded cut 4–5/#51–#53 are explicit. Verify cited anchors at final R, plain text fences, six-column measurement rows and preserved fragment scope. Runtime receipts/signatures remain pending; no host/service command was executed. [Tasks F03–F03f; rulings 40(6), 43–46]

Reviewed fragment fixes retained: the complete lost-shell/timer-recovery fence, the supplied DRILL-LOCAL digest/flag check and the F3 boundary after recycle installation. Final-R citations replace the earlier snapshot anchors; runtime signatures and receipts remain STOP inputs. [C:5015,5051–5052,4811–4813; DRILL:481–494; rulings 40(6),41,43–46]

# 04 — X2 staging fixture and receipts

Interface: HezLead supplies full reviewed R/T pins, clean staging checkouts and a signed fixture review. HezLead is the staging owner; the designated release worker executes these blocks on c1-staging as root. Output is a staging receipt, separate from CI, plus nonsecret diffs/counts/race evidence. R means landed release, not the drafting pin. Re-resolve citations at landed R before dispatch; missing or changed source STOPs. No service measurements or operations were performed while drafting. [TASK-l5-F04b; ruling 40(6); PLAN §1d]

C = docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md; STACK = deploy/supabase-stack; X = tests/p1-server/admin-principal-lock-order.test.ts; H = tests/support/admin-principal-lock-order-harness.mjs. Repository citations below all resolve at final R `2e2ac5e63e851cc84f345a65b3547de365e8ea2e`; G/V source citations now point to the files included in integration at R. Git main landing and signed runtime receipts remain admission requirements. [TASK-l5-F04b]

## Required names and results

Both gate arrays contain the same 15 names. The sole sibling top-level x2_race_classes equals exported X2_RACE_CLASSES. The list below is resolved from that export and its referenced constants, not inferred from comments. Receipts gain no class field. [X:74,91–101,132,158–170,197–207; GATES:276–327; ruling 40(2),(7)]

Race name | Class | T | R
--- | --- | --- | ---
positive-control-raw-sql-base-order-deadlocks | positive-control | PASS | PASS
admin-oauth-vs-hosted-claim-seat | base-cycle | FAIL-40P01 | PASS
admin-oauth-vs-local-join-registration | base-cycle | FAIL-40P01 | PASS
admin-oauth-vs-local-command-creation | base-cycle | FAIL-40P01 | PASS
accept-invitation-vs-hosted-claim-seat | base-cycle | FAIL-40P01 | PASS
accept-invitation-vs-local-join-registration | base-cycle | FAIL-40P01 | PASS
remove-member-vs-hosted-claim-seat | base-cycle | FAIL-40P01 | PASS
remove-member-vs-local-join-registration | base-cycle | FAIL-40P01 | PASS
household-invitation-vs-hosted-claim-seat | base-cycle | FAIL-40P01 | PASS
household-invitation-vs-local-join-registration | base-cycle | FAIL-40P01 | PASS
admin-oauth-vs-admin-oauth-shared-workspace | base-cycle | FAIL-40P01 | PASS
admin-oauth-create-existing-workspace-crossed | base-cycle | FAIL-40P01 | PASS
admin-oauth-read-outside-grant-vs-admin-oauth-routine | regression-guard | PASS | PASS
admin-oauth-grant-admin-delegation-vs-admin-oauth-routine | regression-guard | PASS | PASS
admin-human-withdraw-crossed-grants | base-cycle | FAIL-40P01 | PASS

Counts: 1 positive-control, 12 base-cycle, 2 regression-guard. Positive-control PASS requires exactly one 40P01 session in the T run and exactly one in the R run, each captured within that run's test invocation. Regression guards PASS at T/R; their intermediate-order CI proof is run 38086941694 (b6f5f4b5 plus tests at 281fddd3). A failed test alone does not prove 40P01. Require deterministic parking, SQLSTATE capture control 22012, deadlock_timeout < lock_timeout, write/audit/refusal observations, and zero HTTP calls. [rulings 25(1),40(1); X:74–80,103–126,133–152,171–191,209–222; H:669–670; C:1897–1903,1944–1946; draft X2 rows]

## Staging admission and preparation

All six ruling-18 conditions are mandatory: (1) dump-database.sh at R, ONLINE through backup_ro; (2) no R2 or other off-box upload; (3) fresh 0700 staging task/dump directories and 0600 files; (4) restore only into throwaway Postgres through the drill's four-tool path, with dump-to-restore age 0..3600 s; (5) never stop live staging DB or mount live TLS/env; (6) after EACH variant remove its dump through guarded rm and its own labelled container through docker rm. Any unmet condition STOPs. Never run run-backup.sh/upload-snapshot.py for X2; production is never touched. [ruling 18; STACK/backup/dump-database.sh:4–33; PLAN §1d step 3]

Preconditions: PostgreSQL 17 host clients, node/tsx/typescript, Deno, OpenSSL, Docker Compose and Python 3; installed rm guard; readable staging CA; staging env 0600 with exactly one BACKUP_RO_PASSWORD, read only by make-backup-service.mjs into its protected files, never printed/copied/mounted into the fixture. Fresh generated fixture env/TLS are separate. [STACK/backup/dump-database.sh:13–26; STACK/backup/make-backup-service.mjs:3–25; WORKER-RULES]

The derived Compose allowlist has 13 changes: project; image pinned to live staging RepoDigest; container name; env path; cron command pair; named data volume/declaration; TLS paths; HBA path; healthcheck address; static address; ONE loopback port; deletion of four other services; network name/IPAM. Everything else stays byte-identical, including x-memory-budget and the init-script mount resolved using R's project directory. HBA changes only subnet lines 12–13; lines 2–4,7–9,14–15 stay. Own free /24 overlaps no Docker subnet/host route and is not 172.31.0.0/24. HezLead signs both saved source-to-derived diffs and exactly THREE restore adaptations BEFORE start: fixture container; fixture network with one published loopback port; fixture TLS with verify-full. Extra differences STOP. No GoTrue/Storage/Realtime/PostgREST/edge starts. [PLAN §1d steps 1–2; STACK/compose.yaml:1–214; STACK/postgres/pg_hba.conf:1–15; ruling 20]

**Fixture-credential disposition (ruling 52):** throwaway fixture PostgreSQL/JWT/role credentials and fixture TLS keys are allowed only on staging or in a local fixture, in 0600 files, created and removed by the reviewed fixture code, never in production and never printed. No production credential is created. The following fixture generation is within that scope; guarded fixture cleanup remains required.

Operator blocks below are for later execution in bash on the measured staging host. Supply public measured pins/paths only. Preparation starts no database; run executes T, removes its dump/container/volume, then executes R with new credentials/TLS/container/volume/dump. [PLAN §1d steps 4–5; rulings 18,20]

```
set -euo pipefail
umask 077
R='<MEASURED:landed-full-R-sha>'; T='<MEASURED:reviewed-tests-only-full-T-sha>'
R_TREE='<MEASURED:absolute-clean-R-checkout>'; T_TREE='<MEASURED:absolute-clean-T-checkout>'
EXPECTED_HOST='<MEASURED:c1-staging-hostname>'
STAGING_ENV_FILE='<MEASURED:absolute-staging-env-path>'
RM_GUARD='<MEASURED:absolute-installed-staging-rm-guard-path-ending-in-rm>'
case "$RM_GUARD" in /*) ;; *) printf 'STOP X2: absolute rm guard required\n' >&2; exit 1 ;; esac
test -f "$RM_GUARD"; test -x "$RM_GUARD"; test ! -L "$RM_GUARD"
test "$(hostname)" = "$EXPECTED_HOST"
X2_TASK="$(mktemp -d /tmp/anvil-secret.XXXXXX)"; chmod 0700 "$X2_TASK"
X2_EVIDENCE="$(mktemp -d /tmp/c1b-x2-evidence.XXXXXX)"; chmod 0700 "$X2_EVIDENCE"
test -d "$X2_TASK"; test -d "$X2_EVIDENCE"
cat >"$X2_TASK/operator.py" <<'PY'
import collections, datetime as dt, difflib, hashlib, ipaddress, json, os, pathlib as p, re, secrets, socket, subprocess as sp, sys, time
os.umask(0o077)
task=p.Path(sys.argv[2]); evidence=p.Path(sys.argv[3]); state=task/'state.json'
def need(ok,why):
    if not ok: raise SystemExit('STOP X2: '+why)
def call(argv,*,cwd=None,data=None,env=None,check=True):
    x=sp.run(list(map(str,argv)),cwd=cwd,input=data,env=env,stdout=sp.PIPE,stderr=sp.PIPE)
    if check and x.returncode and p.Path(str(argv[0])).name=='rm': print('BLOCKED by rm guard: '+json.dumps(x.stderr.decode().strip())+'. To resolve: HezLead inspects the exact named path; do not bypass the guard.')
    if check: need(x.returncode==0,'command failed: '+str(argv[0])+'; inspect protected staging evidence')
    return x
def out(argv,**kw): return call(argv,**kw).stdout.decode().strip()
def write(path,value): path.write_text(value); path.chmod(0o600)
def save(path,value): write(path,json.dumps(value,sort_keys=True)+'\n')
def digest(value): return hashlib.sha256(value).hexdigest()
def utc(): return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
def obj(argv): return json.loads(out(argv))[0]
def git(root,*args): return call(['git','-C',root,*args]).stdout
def live():
    ids=out(['docker','ps','--no-trunc','--format','{{.ID}}']).splitlines(); result={}
    for i in ids:
        x=obj(['docker','inspect',i]); result[i]={'started':x['State']['StartedAt'],'image':x['Image']}
    return result
def clean(root,sha):
    need(p.Path(root).is_absolute() and git(root,'rev-parse','HEAD').decode().strip()==sha and not git(root,'status','--porcelain','--untracked-files=normal').strip(),'clean pinned checkout')
if sys.argv[1]=='prepare':
    rroot,troot,R,T,host,staging_env,rm_guard=sys.argv[4:11]; need(re.fullmatch(r'c1-staging(?:-[A-Za-z0-9.-]+)?',host) and out(['hostname'])==host and os.geteuid()==0,'root on assigned staging host')
    need(p.Path(staging_env).is_absolute() and p.Path(staging_env).is_file() and not p.Path(staging_env).is_symlink() and p.Path(staging_env).stat().st_mode&0o777==0o600,'protected staging env metadata')
    need(p.Path(rm_guard).is_absolute() and p.Path(rm_guard).name=='rm' and p.Path(rm_guard).is_file() and not p.Path(rm_guard).is_symlink() and os.access(rm_guard,os.X_OK),'reviewed staging rm guard')
    need(all(re.fullmatch('[0-9a-f]{40}',v) for v in (R,T)) and R!=T,'reviewed distinct pins'); clean(rroot,R); clean(troot,T)
    sides=['tests/p1-server/admin-principal-lock-order.test.ts','tests/p1-server/admin-principal-lock-order-binding.test.ts','tests/p1-server/hosted-mcp-contract-golden.test.ts','tests/support/admin-principal-lock-order-harness.mjs','tests/support/hosted-mcp-contract-golden.json']; git(rroot,'diff','--quiet',T,R,'--',*sides)
    stack=p.Path(rroot)/'deploy/supabase-stack'; src=(stack/'compose.yaml').read_text(); hba=(stack/'postgres/pg_hba.conf').read_text()
    need('  gotrue:\n' in src and src.endswith('    external: true\n'),'reviewed compose shape')
    nets=json.loads(out(['docker','network','inspect',*out(['docker','network','ls','-q']).splitlines()]))
    occupied=[ipaddress.ip_network(x['Subnet']) for n in nets for x in (n.get('IPAM',{}).get('Config') or []) if x.get('Subnet')]
    occupied += [ipaddress.ip_network(x['dst']) for x in json.loads(out(['ip','-j','route','show','table','all'])) if x.get('dst') not in (None,'default')]
    subnet=next((ipaddress.ip_network(f'10.253.{n}.0/24') for n in range(1,255) if all(not ipaddress.ip_network(f'10.253.{n}.0/24').overlaps(x) for x in occupied if x.version==4)),None)
    need(subnet is not None,'free non-overlapping /24'); address=str(subnet.network_address+10)
    with socket.socket() as s: s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
    need(str(port) not in re.findall(r'127\.0\.0\.1:(\d+):',src+(p.Path(rroot)/'deploy/edge-runtime/compose.yaml').read_text()),'non-live port')
    before=live(); pg=obj(['docker','inspect','commonswarm-postgres']); image=obj(['docker','image','inspect',pg['Image']])
    pins=[x for x in image.get('RepoDigests',[]) if re.fullmatch(r'.+@sha256:[0-9a-f]{64}',x)]; need(len(pins)==1,'one live PostgreSQL RepoDigest')
    project='c1b-x2-'+secrets.token_hex(4); net=project+'-net'; vol=project+'-pgdata'
    cfg=dict(rroot=rroot,troot=troot,R=R,T=T,host=host,project=project,net=net,vol=vol,subnet=str(subnet),address=address,port=port,image=pins[0],before=before,staging_env=staging_env,rm_guard=rm_guard)
    js=r"const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');const s=fs.readFileSync(process.argv[1],'utf8'),a=ts.createSourceFile('race.ts',s,ts.ScriptTarget.Latest,true);const names=['POSITIVE_CONTROL','RACE_TESTS','ADMIN_PAIR','ADMIN_CROSS_RACES','ADMIN_WITHDRAW','X2_RACE_CLASSES'];const nodes=a.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(a))));if(nodes.length!==6)throw Error('class source');const code=nodes.map(n=>n.getText(a).replace(/^export /,'')).join('\n')+'\nglobalThis.answer=X2_RACE_CLASSES;';const ctx={};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);process.stdout.write(JSON.stringify(ctx.answer));"
    classes=json.loads(out(['node','-e',js,p.Path(rroot)/sides[0]],cwd=rroot)); gates=json.loads((p.Path(rroot)/'docs/evidence/2026-10-03-admin-issuance-release/GATES.json').read_text())
    need(collections.Counter(classes.values())=={'positive-control':1,'base-cycle':12,'regression-guard':2},'15 source classes')
    need(gates['x2_race_classes']==classes and gates['gates']['admin-principal-lock-order-ci']==gates['gates']['admin-principal-lock-order-staging']==list(classes),'gate arrays/map')
    cfg['classes']=classes; cfg['test_sha']=digest(git(rroot,'show',R+':'+sides[0])); save(state,cfg)
    replacements=[('name: commonswarm-supabase-stack','name: '+project),('image: public.ecr.aws/supabase/postgres:17.6.1.147','image: '+pins[0]),('container_name: commonswarm-postgres','container_name: '+project+'-postgres'),('${COMMONSWARM_ENV_FILE:-/home/commonswarm/.env}',str(task/'fixture.env')),('      - log_statement=none','      - log_statement=none\n      - -c\n      - cron.launch_active_jobs=off'),('${COMMONSWARM_POSTGRES_DATA_DIR:-/var/lib/commonswarm/postgres}',vol),('${COMMONSWARM_DB_CERT_FILE:-/etc/commonswarm/pg-tls/server.crt}',str(task/'server.crt')),('${COMMONSWARM_DB_KEY_FILE:-/etc/commonswarm/pg-tls/server.key}',str(task/'server.key')),('${COMMONSWARM_CA_FILE:-/etc/ssl/yulan-internal-ca.pem}',str(task/'server.crt')),('./postgres/pg_hba.conf',str(task/'pg_hba.conf')),('172.31.0.10',address),('    networks:\n','    ports:\n      - "127.0.0.1:'+str(port)+':5432"\n    networks:\n')]
    derived=src[:src.index('  gotrue:\n')]
    for old,new in replacements: need(old in derived,'allowlist source anchor'); derived=derived.replace(old,new)
    derived+='networks:\n  commonswarm-net:\n    name: '+net+'\n    ipam:\n      config:\n        - subnet: '+str(subnet)+'\nvolumes:\n  '+vol+':\n    name: '+vol+'\n'
    lines=hba.splitlines(True)
    for i in (11,12): need('172.31.0.0/24' in lines[i],'HBA source anchor'); lines[i]=lines[i].replace('172.31.0.0/24',str(subnet))
    write(task/'compose.yaml',derived); write(task/'pg_hba.conf',''.join(lines))
    for name,old,new in [('compose',src,derived),('hba',hba,''.join(lines))]: write(evidence/(name+'.diff'),''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='R/'+name,tofile='fixture/'+name)))
    save(evidence/'review-input.json',dict(R=R,T=T,compose_sha256=digest(derived.encode()),hba_sha256=digest(''.join(lines).encode()),adaptations=['fixture container','one published loopback port','fixture TLS'],staging_env=staging_env,rm_guard=rm_guard,rm_guard_sha256=digest(p.Path(rm_guard).read_bytes())))
    save(evidence/'live-before.json',before); print('X2_TASK='+str(task)+'\nX2_EVIDENCE='+str(evidence)+'\nRM_GUARD='+rm_guard)
    for name in ('compose.diff','hba.diff'): print(str(evidence/name)+'\n'+(evidence/name).read_text())
    print('Review input: '+str(evidence/'review-input.json')+'\nPrepared; STOP before start until HezLead signs the diff/adaptation review.'); sys.exit(0)
c=json.loads(state.read_text()); stack=p.Path(c['rroot'])/'deploy/supabase-stack'; project,net,vol=c['project'],c['net'],c['vol']
need(out(['hostname'])==c['host'] and os.geteuid()==0 and task.resolve()==task and task.name.startswith('anvil-secret.') and task.stat().st_mode&0o777==0o700,'task/host binding')
review=json.loads(p.Path(sys.argv[4]).read_text()); expected=json.loads((evidence/'review-input.json').read_text())
need(sys.argv[1]=='run','explicit run mode'); need(review.get('inputs')==expected and review.get('status')=='PASS' and review.get('signed_by')=='HezLead','signed diff review')
need(digest((task/'compose.yaml').read_bytes())==expected['compose_sha256'] and digest((task/'pg_hba.conf').read_bytes())==expected['hba_sha256'],'reviewed bytes')
need(sys.argv[5]==c['rm_guard'] and not p.Path(c['rm_guard']).is_symlink() and digest(p.Path(c['rm_guard']).read_bytes())==expected['rm_guard_sha256'],'rm guard path/bytes unchanged'); os.environ['PATH']=str(p.Path(c['rm_guard']).parent)+':'+os.environ.get('PATH','')
compose=['docker','compose','--project-directory',stack,'-p',project,'-f',task/'compose.yaml']
def bound(cid):
    x=obj(['docker','inspect',cid]); need(x['Id']==cid and x['Name']=='/'+project+'-postgres' and cid not in c['before'] and x['Config']['Labels']['com.docker.compose.project']==project,'owned container')
    need(list(x['NetworkSettings']['Networks'])==[net],'one own network')
    for kind,name in [('network',net),('volume',vol)]: need(obj(['docker',kind,'inspect',name])['Labels']['com.docker.compose.project']==project,'owned '+kind)
    need([m['Name'] for m in x['Mounts'] if m['Destination']=='/var/lib/postgresql/data' and m['Type']=='volume']==[vol],'own data volume')
    need(all(m['Type']!='bind' or m['Source']==str(stack/'postgres/10-runtime-roles.sh') or p.Path(m['Source']).parent==task for m in x['Mounts']),'no live bind mounts')
    ports=[(k,v) for k,vs in x['NetworkSettings']['Ports'].items() for v in (vs or [])]; need(ports==[('5432/tcp',{'HostIp':'127.0.0.1','HostPort':str(c['port'])})],'one loopback port')
    need(x['Image']==obj(['docker','image','inspect',c['image']])['Id'],'image equality')
def sql(cid,q): return out(['docker','exec','-i',cid,'sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -Atq'],data=q.encode())
def hostsql(q,wrong=False):
    e={k:v for k,v in os.environ.items() if not k.startswith('PG')}; e.update(PGSERVICEFILE=str(task/('wrong-service' if wrong else 'host-service')),PGPASSFILE=str(task/'host-pass'),PGSERVICE='target')
    return call(['psql','-X','-v','ON_ERROR_STOP=1','-Atq','-c',q],env=e,check=False)
shape=git(c['rroot'],'show',c['R']+':deploy/RELEASE-TO-BOX.md').decode().splitlines()[2058:2074]
shape='\n'.join(shape).replace('\\$','$')+'\n'; need(shape.startswith('DO $ledger_shape$') and shape.rstrip().endswith('$ledger_shape$;'),'re-resolved ledger-shape source')
receipt=dict(kind='staging',release_sha=c['R'],base_variant_sha=c['T'],test_file_sha256=c['test_sha'],host=c['host'],compose_project=project,compose_network=net,compose_volume=vol,postgres_image_digest=c['image'].split('@')[1],runs={})
need(live()==c['before'],'live state unchanged since signed preparation')
with socket.socket() as s: s.bind(('127.0.0.1',c['port']))
for variant,root,sha in [('base',c['troot'],c['T']),('lane',c['rroot'],c['R'])]:
    need(not (evidence/(variant+'.json')).exists(),'no automatic rerun'); cid=None; parent=None
    try:
        clean(root,sha); pw=secrets.token_hex(24)
        write(task/'fixture.env','POSTGRES_DB=postgres\nPOSTGRES_USER=supabase_admin\nPOSTGRES_HOST=/var/run/postgresql\nPOSTGRES_PORT=5432\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\nPOSTGRES_PASSWORD='+pw+'\nJWT_SECRET='+secrets.token_hex(32)+'\nJWT_EXP=3600\nBACKUP_RO_PASSWORD='+secrets.token_hex(24)+'\nCOMMONSWARM_EDGE_DB_PASSWORD='+secrets.token_hex(24)+'\n')
        for stem,san in [('server','DNS:db.commonswarm.internal,IP:'+c['address']+',IP:127.0.0.1'),('wrong','DNS:wrong.invalid')]:
            call(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+stem,'-addext','subjectAltName='+san,'-addext','basicConstraints=critical,CA:TRUE','-keyout',task/(stem+'.key'),'-out',task/(stem+'.crt')])
            for suffix in ('.key','.crt'): (task/(stem+suffix)).chmod(0o600)
        uid=int(out(['docker','run','--rm','--label','com.docker.compose.project='+project,'--entrypoint','id',c['image'],'-u','postgres'])); os.chown(task/'server.key',uid,-1); os.chown(task/'server.crt',uid,-1); os.chown(task/'pg_hba.conf',uid,-1)
        call(compose+['up','-d','postgres']); cid=out(compose+['ps','-q','postgres']); cid=obj(['docker','inspect',cid])['Id']; deadline=time.monotonic()+180
        while b'CommonSwarm runtime roles and required image extensions are ready.' not in call(['docker','logs',cid]).stdout:
            need(time.monotonic()<deadline,'180 s init-marker readiness'); time.sleep(1)
        bound(cid)  # Before any client connection or SQL.
        write(task/'binding.json',json.dumps(dict(mode='fixture',db_container_id=cid,db_url=f'postgresql://supabase_admin:{pw}@127.0.0.1:{c["port"]}/postgres?sslmode=verify-full',db_tls_ca_file=str(task/'server.crt'),compose_project=project,compose_network=net,compose_volume=vol)))
        service=f'[target]\nhost=127.0.0.1\nport={c["port"]}\ndbname=postgres\nuser=supabase_admin\nsslmode=verify-full\nsslrootcert={task}/server.crt\nconnect_timeout=3\n'
        write(task/'host-service',service); write(task/'wrong-service',service.replace('server.crt','wrong.crt')); write(task/'host-pass',f'127.0.0.1:{c["port"]}:postgres:supabase_admin:{pw}\n')
        while True:
            x=hostsql('SHOW commonswarm.stack_identity;')
            if x.returncode==0: break
            need(time.monotonic()<deadline,'first verified TLS connection'); time.sleep(1)
        need(x.stdout.strip()==b'n-db-target-v1','stack identity'); bad=hostsql('SELECT 1;',True)
        need(bad.returncode!=0 and b'certificate verify failed' in bad.stderr.lower(),'wrong-CA TLS control')
        need(ipaddress.ip_address(hostsql('SELECT inet_client_addr();').stdout.decode().strip()) in ipaddress.ip_network(c['subnet']),'client inside fixture subnet')
        save(evidence/(variant+'-tls.json'),dict(identity='n-db-target-v1',verify_full='PASS',wrong_ca='TLS-REFUSED'))
        sql(cid,f'ALTER DATABASE postgres SET "commonswarm.local_rehearsal" TO \'1\'; ALTER DATABASE postgres SET "commonswarm.local_target_address" TO \'{c["address"]}\';')
        parent=p.Path(out(['mktemp','-d','/tmp/anvil-secret.XXXXXX'])); parent.chmod(0o700); dump=parent/'database'
        dumpenv=os.environ.copy(); dumpenv['COMMONSWARM_ENV_FILE']=c['staging_env']
        call(['bash',stack/'backup/dump-database.sh',dump],env=dumpenv); completed=utc(); need((dump/'SHA256SUMS').is_file(),'dump manifest')
        need(all((x.stat().st_mode&0o777)==(0o700 if x.is_dir() else 0o600) and not x.is_symlink() for x in [dump,*dump.rglob('*')]),'dump modes'); call(['sha256sum','--check','SHA256SUMS'],cwd=dump)
        backup=dict(file=str(dump/'SHA256SUMS'),sha256=digest((dump/'SHA256SUMS').read_bytes()),source_host=c['host'],dump_completed_at=completed)
        schemas=out(['bash','-c','source "$1/migrate/lib.sh"; selected_schema_csv','x2',stack]); need('schemas='+schemas in (dump/'manifest.txt').read_text().splitlines() and 'commonswarm_ops' in schemas.split(','),'Lane 6 schema set')
        write(task/'tool-service',f'[target]\nhost={c["address"]}\nport=5432\ndbname=postgres\nuser=supabase_admin\nsslmode=verify-full\nsslrootcert=/run/fixture-ca\n'); write(task/'tool-pass',f'{c["address"]}:5432:postgres:supabase_admin:{pw}\n')
        started=utc(); need(0<=(dt.datetime.fromisoformat(started.replace('Z','+00:00'))-dt.datetime.fromisoformat(completed.replace('Z','+00:00'))).total_seconds()<=3600,'dump-to-restore age')
        for tool in ('restore-target.sh','prepare-target.sh','restore-cron-jobs.sh','verify-counts.sh'):
            args=['docker','run','--rm','--network',net,'--env-file',task/'fixture.env','-e','MIGRATION_ARTIFACT_DIR=/artifacts','-e','PGSERVICEFILE=/run/service','-e','PGPASSFILE=/run/pass','-e','TARGET_DATABASE_URL=isolated-cold-recovery','-v',str(stack)+':/work:ro','-v',str(dump)+':/artifacts','-v',str(task/'tool-service')+':/run/service:ro','-v',str(task/'tool-pass')+':/run/pass:ro','-v',str(task/'server.crt')+':/run/fixture-ca:ro','--label','com.docker.compose.project='+project,'--entrypoint','/bin/bash',c['image'],'/work/migrate/'+tool]
            x=call(args,check=False); write(task/(variant+'-'+tool+'.log'),(x.stdout+x.stderr).decode()); need(x.returncode==0,'restore tool '+tool)
        need(hostsql('SHOW commonswarm.stack_identity;').stdout.strip()==b'n-db-target-v1' and hostsql('SELECT 1;',True).returncode!=0,'post-restore TLS'); sql(cid,shape)
        actual_schemas=sql(cid,"SELECT nspname FROM pg_namespace WHERE nspname=ANY(string_to_array('"+schemas+"',',')) ORDER BY nspname;").splitlines(); need(actual_schemas==sorted(schemas.split(',')),'restored schema-set equality')
        counts=dict(line.split('|') for line in (dump/'source-counts.tsv').read_text().splitlines()); restored_count=sql(cid,'SELECT count(*) FROM commonswarm_ops.migration_checksums;')
        need(int(restored_count)>0 and counts.get('commonswarm_ops.migration_checksums')==restored_count,'restored positive checksum count equals dump'); save(evidence/(variant+'-restore-checks.json'),dict(schemas=schemas.split(','),counts=counts,cron='MATCH',checksum_count=restored_count))
        ledger=sql(cid,'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').splitlines(); files={}
        for name in git(root,'ls-tree','--name-only',sha,'--','supabase/migrations/').decode().splitlines():
            if not name.endswith('.sql'): continue
            m=re.fullmatch(r'supabase/migrations/([0-9]{14})_.+\.sql',name); need(m and m[1] not in files,'one SQL file/version'); files[m[1]]=name
        need(ledger==sorted(set(ledger)) and set(ledger)<=set(files),'restored ledger belongs to run tree'); restored=utc(); need(restored>=started,'restore timestamp not before start'); restore=dict(db_container_id=cid,database='postgres',restore_started_at=started,restored_at=restored,ledger_versions=ledger)
        delta=sorted(set(files)-set(ledger)); prefix=list(ledger); applied=[]
        for version in delta:
            proofs=[n for n in git(root,'ls-tree','-r','--name-only',sha,'--','deploy/release-proofs/').decode().splitlines() if n.endswith('/'+version+'-catalog.sql')]; need(len(proofs)==1,'one catalog proof')
            migration=git(root,'show',sha+':'+files[version]); proof=git(root,'show',sha+':'+proofs[0]); h=digest(migration)
            need(sql(cid,"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='"+version+"';")=='0','delta precheck ledger')
            need(sql(cid,proof.decode()+"\n\\if :{?catalog_ok}\n\\echo :catalog_ok\n\\else\n\\echo invalid\n\\endif\n").splitlines()[-1]=='f','delta precheck catalog')
            array='ARRAY['+','.join("'"+v+"'" for v in sorted(prefix))+']::text[]'
            q="BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5min'; LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;\nDO $prefix$ BEGIN IF (SELECT COALESCE(array_agg(version ORDER BY version),ARRAY[]::text[]) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM "+array+" THEN RAISE EXCEPTION 'unexpected ledger prefix'; END IF; END $prefix$;\n"+shape+migration.decode()+"\nINSERT INTO supabase_migrations.schema_migrations(version) VALUES ('"+version+"');\n"+proof.decode()+"\n\\if :{?catalog_ok}\nSELECT :'catalog_ok'='t' AS catalog_is_t \\gset\n\\if :catalog_is_t\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'catalog proof failed'; END $$;\n\\endif\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'catalog proof missing'; END $$;\n\\endif\n"
            q+="GRANT commonswarm_admin_release TO supabase_admin WITH ADMIN TRUE, INHERIT FALSE, SET TRUE; SET LOCAL ROLE commonswarm_admin_release; INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES ('"+version+"','"+h+"','release','"+sha+"'); RESET ROLE; GRANT commonswarm_admin_release TO supabase_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; COMMIT;\n"
            sql(cid,q); prefix.append(version); applied.append(dict(version=version,file=files[version],sha256=h,catalog=proofs[0],catalog_sha256=digest(proof)))
        need(sql(cid,'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;').splitlines()==sorted(files),'final ledger equals run tree')
        subset=['2026100100000'+str(i) for i in range(1,6)]+['20260928000003','20261002000001']+['2026100300000'+str(i) for i in range(1,6)]
        for v in subset:
            need(v in files and v in prefix,'C1 subset ledger'); h=digest(git(root,'show',sha+':'+files[v])); rows=sql(cid,"SELECT sha256||'|'||source FROM commonswarm_ops.migration_checksums WHERE version='"+v+"';").splitlines(); need(len(rows)==1 and rows[0] in (h+'|release',h+'|backfill'),'C1 subset exact checksum')
        save(evidence/(variant+'-migrations.json'),dict(applied=applied,subset=subset,ledger=sorted(files)))
        write(task/'capture.mjs',"import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';const orig=cp.spawn;cp.spawn=function(...a){const ch=orig(...a);if(a[0]==='deno'){let b='';ch.stdout.on('data',x=>{b+=x;let n;while((n=b.indexOf('\\n'))>=0){const l=b.slice(0,n);b=b.slice(n+1);if(l.startsWith('LOCK_ORDER_RESULT '))appendFileSync(process.env.X2_OBSERVATIONS,l.slice(18)+'\\n',{mode:0o600});}});}return ch;};syncBuiltinESMExports();\n")
        observed=evidence/(variant+'-observed.ndjson'); write(observed,''); env=os.environ.copy(); env.update(C1B_LOCK_ORDER_BINDING=str(task/'binding.json'),X2_OBSERVATIONS=str(observed))
        x=call(['node','--import',task/'capture.mjs','--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',p.Path(root)/'tests/p1-server/admin-principal-lock-order.test.ts'],cwd=root,env=env,check=False); tap=x.stdout.decode(); write(evidence/(variant+'.tap'),tap)
        tree=git(root,'rev-parse',sha+':supabase/migrations').decode().strip(); need(f'C1B_LOCK_ORDER_TREE head={sha} migrations={tree}' in tap,'runtime tree line')
        rows=re.findall(r'^(not ok|ok) [0-9]+ - (.+)$',tap,re.M); need(len(rows)==15 and {n for _,n in rows}==set(c['classes']),'exact 15 tests, no skips/extras'); results={}
        for status,name in rows:
            if status=='ok': results[name]='PASS'
            else:
                block=tap.split('# Subtest: '+name+'\n',1)[1].split('# Subtest:',1)[0]; need('SQLSTATE 40P01 (deadlock_detected) in 1 transaction(s)' in block and 'ERR_ASSERTION' in block,'failure is one captured 40P01'); results[name]='FAIL-40P01'
        observations=[json.loads(l) for l in observed.read_text().splitlines()]; need(len(observations)==14 and {o['scenario'] for o in observations}==set(c['classes'])-{'positive-control-raw-sql-base-order-deadlocks'},'same-invocation observations')
        for o in observations: need(o['stage']=='complete' and o['sqlstate_capture_control']=='22012' and o['deadlock_timeout_ms']<o['lock_timeout_ms'] and o['parking'] and all(o['parking'].values()) and o['http_refused']==0,'race prerequisites')
        for o in observations:
            need(isinstance(o.get('writes'),dict) and o['writes'] and all(type(v) is bool for v in o['writes'].values()),'write observations present')
            if o['scenario'].startswith('admin-oauth-'): need(isinstance(o.get('admin_audit'),list),'OAuth audit observations present (empty permitted for rolled-back T session)')
            for side in ('parked','waiting'):
                s=o.get(side); need(isinstance(s,dict) and type(s.get('ok')) is bool and (all(k in s for k in ('status','body_status','error')) or isinstance(s.get('thrown'),str)),'side outcome/refusal observations present')
        for o in observations: need(o.get('sqlstates')==(['40P01'] if results[o['scenario']]=='FAIL-40P01' else []),'SQLSTATE by code, no other failure')
        want={n:('FAIL-40P01' if variant=='base' and cl=='base-cycle' else 'PASS') for n,cl in c['classes'].items()}; need(results==want and x.returncode==(1 if variant=='base' else 0),'class verdict and exit')
        receipt['runs'][variant]=dict(sha=sha,migration_sha=tree,backup=backup,restore=restore,applied_versions=delta,results=results); save(evidence/(variant+'.json'),receipt['runs'][variant])
    finally:
        if parent is not None: need(parent.resolve()==parent and parent.parent==p.Path('/tmp') and parent.name.startswith('anvil-secret.'),'dump cleanup path'); call([c['rm_guard'],'-r','--',parent])
        if cid is not None:
            bound(cid); call(['docker','stop',cid]); call(['docker','rm',cid]); need(obj(['docker','volume','inspect',vol])['Labels']['com.docker.compose.project']==project,'volume cleanup label'); call(['docker','volume','rm',vol])
need(receipt['runs']['base']['backup']['file']!=receipt['runs']['lane']['backup']['file'] and receipt['runs']['base']['backup']['sha256']!=receipt['runs']['lane']['backup']['sha256'] and receipt['runs']['base']['restore']['db_container_id']!=receipt['runs']['lane']['restore']['db_container_id'],'distinct dumps/restores')
need(obj(['docker','network','inspect',net])['Labels']['com.docker.compose.project']==project,'network cleanup label'); call(['docker','network','rm',net])
need(live()==c['before'],'live IDs/start times/images unchanged'); save(evidence/'live-after.json',live()); save(evidence/'staging.json',receipt)
need(not out(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]) and not out(['docker','volume','ls','-q','--filter','label=com.docker.compose.project='+project]),'no fixture residue')
print('Staging receipt: '+str(evidence/'staging.json'))
PY
python3 "$X2_TASK/operator.py" prepare "$X2_TASK" "$X2_EVIDENCE" "$R_TREE" "$T_TREE" "$R" "$T" "$EXPECTED_HOST" "$STAGING_ENV_FILE" "$RM_GUARD"
```

STOP for HezLead's signed review: JSON status=PASS, signed_by=HezLead, inputs exactly review-input.json (R/T, compose_sha256, hba_sha256, three adaptations, staging env path and rm guard path/hash). Review both printed diffs against all 13 changes and two HBA edits; recheck free subnet/routes/port before execution. Fill the next fence's X2_TASK, X2_EVIDENCE and RM_GUARD from preparation's printed absolute paths, including in a fresh shell. Empty, unset or invalid paths STOP before Python or removal. [rulings 20,40(6); PLAN §1d step 2; TASK-l5-F04c]

```
set -euo pipefail
umask 077
X2_TASK='<MEASURED:absolute-X2_TASK-from-printed-prepare-output>'
X2_EVIDENCE='<MEASURED:absolute-X2_EVIDENCE-from-printed-prepare-output>'
RM_GUARD='<MEASURED:absolute-RM_GUARD-from-printed-prepare-output>'
X2_REVIEW_RECEIPT='<MEASURED:absolute-HezLead-signed-diff-review-json>'
: "${X2_TASK:?STOP X2: missing task}" "${X2_EVIDENCE:?STOP X2: missing evidence}" "${RM_GUARD:?STOP X2: missing rm guard}"
for path in "$X2_TASK" "$X2_EVIDENCE" "$RM_GUARD"; do case "$path" in /*) ;; *) printf 'STOP X2: absolute paths required\n' >&2; exit 1 ;; esac; done
test -d "$X2_TASK"; test ! -L "$X2_TASK"
test -d "$X2_EVIDENCE"; test ! -L "$X2_EVIDENCE"
test -f "$RM_GUARD"; test -x "$RM_GUARD"; test ! -L "$RM_GUARD"
python3 "$X2_TASK/operator.py" run "$X2_TASK" "$X2_EVIDENCE" "$X2_REVIEW_RECEIPT" "$RM_GUARD"
"$RM_GUARD" -r -- "$X2_TASK"
```

Initial readiness uses only the init log marker, bounded 180 s; no SQL/client readiness probe. Docker's preserved healthcheck is not the gate. Inspect own container/network/volume labels, mounts, image and ONE port before first SQL. First SQL is SHOW commonswarm.stack_identity through verify-full, identity n-db-target-v1; wrong CA must fail TLS before any query; client address must be inside fixture subnet. Binding keys exactly: mode, db_container_id, db_url, db_tls_ca_file, compose_project, compose_network, compose_volume. Never print binding values, env/TLS material, full inspect or protected tool logs. [STACK/postgres/10-runtime-roles.sh:27,48–54; H:23–28,99–193,210–233; PLAN §1d 4a–b]

Each run takes its OWN online dump after readiness, hashes SHA256SUMS binding the eight artifact files, records UTC completion only after exit 0, verifies modes/hashes, then UTC start immediately before restore-target.sh. Age <0 or >3600 s STOPs before restore. The four R tools run IN ORDER, each in a --rm tool container: restore-target.sh, prepare-target.sh, restore-cron-jobs.sh, verify-counts.sh. Exact schema-set equality, all selected per-table counts INCLUDING positive commonswarm_ops.migration_checksums, and cron equality must match that dump. [rulings 18,20; STACK/backup/dump-database.sh:27–33; STACK/backup/restore-drill.py:323–372; STACK/migrate/restore-target.sh:27–64; STACK/migrate/verify-counts.sh:36–70]

Delta = run-tree versions minus restored ledger, lexical, one file/version. Foreign restored version STOPs. Each delta uses precheck 0/f, ONE catalog proof, then ONE ON_ERROR_STOP psql transaction: BEGIN/timeouts, ledger lock/prefix/shape guards, exact Git migration bytes, version-only INSERT, catalog proof, release checksum row under commonswarm_admin_release (released_sha=run SHA), COMMIT. No skip/reorder/retry/batch/Supabase CLI. Final ledger equals whole run tree. Separate twelve-file C1 check: one file/version, ledger present, SHA-equal release/backfill checksum row; restored released_sha stays unchanged. Lane 6 is present at this pin; final R may not claim the historical missing-commonswarm_ops degrade path. [deploy/RELEASE-TO-BOX.md:1972–1984,1992–2030,2055–2096,2105–2107; C:3193–3218,7110–7117; ruling 17; PLAN §1d 4d–g]

After EACH run, including failure, guarded rm removes only its exact checked dump parent; label checks precede docker stop/docker rm by container ID and volume rm by exact name. T cleanup must pass before R. After R remove the exact labelled network, verify zero fixture container/volume/dump residue and unchanged live IDs/start times/images; remove generated task material via guarded rm. Never compose down, prune, wildcard-delete or bypass rm. Startup failure before ID capture, any uncertain target or cleanup refusal STOPs; leave exact named residue for HezLead's signed cleanup. Protected restore logs stay in the task directory until cleanup; copy only counts/statuses, never dump or customer content. [rulings 18(6),20; PLAN §1d 4i–5; WORKER-RULES]

## Receipt and deciding measurements

staging.json exact top-level keys: kind, release_sha, base_variant_sha, test_file_sha256, host, compose_project, compose_network, compose_volume, postgres_image_digest, runs. kind=staging; runs contains base and lane only. Each run: sha, migration_sha, backup, restore, applied_versions, results. backup: file, sha256, source_host, dump_completed_at (file points to that run's SHA256SUMS). restore: db_container_id, database, restore_started_at, restored_at, ledger_versions (database=postgres; ledger is sorted unique PRE-delta). No top-level backup/migration_sha/image_digests or class field. [C:1917–1936; PLAN §1d receipt; ruling 40(7)]

Every location below is under <MEASURED:X2_EVIDENCE> unless a receipt key is given. These are expected values, not observed service measurements. [TASK-l5-F04; PLAN §1b]

deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck
--- | --- | --- | --- | --- | ---
R/T and test bytes | Distinct reviewed pins, five files equal, test digest equal at both trees (C:1934–1943) | HezLead/release worker | Missing object/pin, dirty tree, unequal bytes | review-input.json, staging.json | Git HEAD/diff/show before preparation and each run
Names/classes | 15 unique, 1/12/2, both arrays equal export/map (X:199–207; GATES:276–327; ruling 40) | HezLead | Missing/extra/duplicate/misclassed name | Signed review, runs.*.results | Evaluate constant-only source; compare both arrays/map
Derived fixture | 13 changes, two HBA edits, three reviewed adaptations (PLAN §1d; ruling 20) | HezLead/independent reviewer | Extra diff, unsigned/drifted bytes, live path/default | compose.diff, hba.diff, review-input.json | Rehash before start; label/mount/port gate
Readiness/binding/TLS | Marker ≤180 s; own inspected target; identity/TLS positive and wrong-CA negative; fixture client subnet (H:99–193; PLAN §1d 4a–b) | Release worker | SQL before inspect, timeout, wrong target/identity/CA/subnet | base/lane-tls.json; protected bindings remain staging-only | Bound inspect plus TLS controls before dump/after restore
Own online dump | R tool, backup_ro, 0700/0600, eight-file hash PASS, no off-box upload (ruling 18; dump-database.sh:4–33) | Release worker | Any condition fails or shared file/hash | runs.base/lane.backup | Mode/SHA256SUMS and distinct file/hash checks
Restore times | UTC, age 0..3600 s, restored_at ≥ started_at (C:1956–1964) | Release worker | Missing/malformed time, negative/3601 s age | runs.*.backup/restore | UTC immediately after dump and before first tool
Restore integrity | Four tools in order; schema/count/cron equality; positive checksum count (ruling 20; verify-counts.sh:36–70) | Release worker | Tool error, drift, missing commonswarm_ops | base/lane-restore-checks.json; protected logs | Manifest/verify-counts and checksum count before delta
Ledger/delta/twelve-file subset | Tree minus restored ledger, one transaction/version, exact twelve checksums (PLAN §1d 4d–g; C:7110–7117) | Release worker | Foreign/duplicate version, failed proof/apply/checksum | base/lane-migrations.json; runs.*.migration_sha/restore/applied_versions | Runtime tree, locked prefix, final ledger and subset check
Race results | Class table; same-invocation control and deterministic SQLSTATE proof (ruling 40(1); C:1944–1946; H:1107–1114,1186–1195,1324–1332,1416–1424) | HezLead/release worker | Skip/hang, wrong SQLSTATE, missing scenario-required parking/write/audit/refusal proof, wrong result | base/lane.tap, base/lane-observed.ndjson; runs.*.results | Script checks field presence; HezLead reviews exact sidecar values/exit before signing
Cleanup/admission | Per-run deletion, live unchanged; distinct R/T-bound CI/staging receipts before opening (rulings 18,20; C:1892–1971) | HezLead | Residue/refusal/live change, missing/foreign CI receipt | live-before/after.json, staging.json; separate CI/gate receipts | Named label checks; landed-R ai-gates

The script requires nonempty boolean writes, audit arrays for admin-oauth scenarios (empty allowed after T rollback; other scenarios emit no audit), and both side outcomes with status/body_status/error or a thrown SQLSTATE. Missing fields STOP. HezLead reviews same-invocation sidecar values for writes/audits/refusals, signs staging evidence, and copies ONLY nonsecret diffs/counts/race logs/receipts to the Mac evidence root. Distinct CI/staging receipt digests; base.sha=T, lane.sha=R; each migration_sha equals its run-time tree; test hashes agree across both receipts and T/R trees. Landed-R ai-gates must PASS with both receipts before W6 admission, W7 and any later issuance opening. The runner's expected base exit 1 is not itself gate admission. Before issuance beyond the owner smoke, also require follow-up #50's typed retryable consent error gate (ruling 37(b)); X2 does not discharge it. [H:822,1033,1107–1114,1186–1195,1324–1332,1416–1424; C:1892–1971; C:1897–1972; GATES:363–412; ruling 40(6),(7); FOLLOW-UPS-C1 #33]

# 05 — Identities, W1, order and freeze

Interface: inputs are reviewed landed R, the approved window inputs, measured production identity receipts, a measured synthetic staging identity record, and HezLead's signed gates. Outputs are I1 re-pin receipts, the retained 7Rh7NR disposition, the ordered pass log and the W7 Mac-close receipt. Unknowns remain `<MEASURED:...>` and STOP execution. This fragment authorizes no worker service contact. [TASK-l5-F05; rulings 33, 37(b), 40(6)]

Repository citations resolve at final R. C = `docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md`; SITE = `docs/evidence/2026-10-02-site-release/SITE-RELEASE.md`; O = `deploy/mcp-auth/OAUTH-RELEASE.md`. External GAP = `/Users/yulanbot/work/c1-frozen-resume/C1-GAP-A-REPORT.md`; P/PLAN = `/Users/yulanbot/work/c1-frozen-resume/build-b/PLAN.md`; FU = `/Users/yulanbot/work/c1-verify/review/FOLLOW-UPS-C1.md`. These external authorities are retained at their exact paths, rather than represented as Git files. Source and execution receipt equality are STOP prerequisites. [TASK-l5-F05; P §3]

Evidence root `F05_EVIDENCE=<MEASURED:absolute-private-pass-evidence-directory>` is created by HezLead, mode 0700; receipts are 0600, contain identifiers/counts/statuses/hashes only, and contain no credentials or customer content. Keep historical records intact. The paths below are receipt destinations, not claims that receipts already exist. [GAP:106–120; C:9512–9518; WORKER-RULES]

## I1 — re-pin each consumer before use (item 19)

Never reuse historical **56b40671/919ce195 prefixes** as new-owner or workspace proof. Measure the complete UUID, provider/session identity, exact workspace name and live role. Smoke needs an unrevoked **owner** membership; a member role cannot pass. Every row below has the six required measurement columns; its first cell names the old literal or existing input and its deciding measurement. [GAP:106–120; P:117,272; C:7922–7929]

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| Site human: already input `control_user_id`; old `d37e2ff2` prefix; measure full signed-in human UUID/provider/profile | `<MEASURED:production-owner-uuid>` matches the approved separate profile (SITE:49,865–867 at final R; GAP §4) | HezLead; Tom signs in | Old identity, wrong provider/profile or missing proof | `$F05_EVIDENCE/I1-site-human.json` | Re-read SITE:865–867 browser-session input against the receipt |
| Site control workspace: already input `control_workspace_id`; old `c2ea0541` prefix; measure UUID/name/access | `<MEASURED:control-workspace-uuid>` and measured new-owner access (SITE:50,900–902 at final R; GAP §4) | HezLead | Stale UUID or inaccessible workspace | `$F05_EVIDENCE/I1-site-control-workspace.json` | SITE:900–902 checks the current browser workspace |
| Site start workspace literal `292be0f9-ca5d-43ed-a6f7-31354fe7fe56`; measure new-owner access | Accessible starting/restored workspace proven at each consumer (SITE:901,1619,1745,2087,2130,2670–2672 at final R; GAP §4) | HezLead | No access; STOP for a reviewed parameterization before use | `$F05_EVIDENCE/I1-site-start.json` | Recheck every listed S consumer and browser restoration receipt |
| P-7 account: historical account in `CHECKLIST:81–82`; measure Google owner/profile | `<MEASURED:google-owner-uuid>` in new task/checklist, separate profile (GAP §4; P:117) | HezLead; Tom signs in | Old account or shared site profile | `$F05_EVIDENCE/I1-P7-account.json` | Compare new P-7 task/checklist to signed-in identity before action |
| P-7 workspace: historical `W5TASK:69`; measure new-owner workspace/access | `<MEASURED:P7-workspace-uuid>` and required access in new task (GAP §4; P:117) | HezLead | Prefix-only proof or absent access | `$F05_EVIDENCE/I1-P7-workspace.json` | New P-7 task's full UUID and access receipt agree |
| Controls release/live edge: historical controls files; measure R and actual phase edge SHA | Full landed R plus mandatory `--live-edge-sha <MEASURED:phase-live-edge-sha>` (C:2052,2081 at final R; GAP §4) | HezLead | Missing flag, stale SHA, foreign receipt | `$F05_EVIDENCE/I1-controls-release.json` | C:1509,1528 validate receipt release/phase/live-edge bindings |
| Controls workspace/profiles/receipt paths: historical `CTRLBEFORE:7,10,13`, CTRLTEMPLATE:5–6, W5TASK:87–91; measure all destinations and identities | New R-bound workspace, separate human/seat profiles and fresh receipt paths; historical files retained (GAP §4; C:2052–2081 at final R) | HezLead | Overwritten history, wrong target/profile or stale consent | `$F05_EVIDENCE/I1-controls-targets.json` | C:2081 successful same-R W4 close and retained opening consent chain |
| P-5 CLI/profile: historical CHECKLIST:59–74/W5TASK:90; measure CLI bytes and owner file-store target | `<MEASURED:CLI-sha256/profile/target>` agrees with new P-5 task (GAP §4:112, CHECKLIST:59–74) | HezLead | Unbound CLI/profile or wrong owner | `$F05_EVIDENCE/I1-P5-session.json` | Recheck protected profile target before members/revoke commands |
| P-5 workspace/name/principal: historical CHECKLIST:64–65; measure live named agent's `principal_id` and old owner | Actual `principal_id`, never receipt `seat_id`; revoke once and prove live absence (C:9547–9557 at final R; GAP §4) | HezLead; current workspace owner/admin executes | Guessed principal, mismatched owner/name or unproven revoke | `$F05_EVIDENCE/I1-P5-principal.json` | Fresh members result after revoke; record any accepted residue explicitly |
| Controls seat name: old per-release `c1-controls-runner-<sha8>`; measure unused per-pass identity | `c1-controls-runner-<R8>-<pass>`; pass matches `^[a-z0-9]{8}$`, fresh once per pass (scripts/live-ordinary-controls.mjs:33,201–202 at final R; P §5 Q13) | HezLead | Missing/reused foreign pass, held old-owner name | `$F05_EVIDENCE/I1-controls-pass.json` | Producer's same-pass name is stable; a different pass has a different name |
| Controls request id: old per-release policy; measure pass-bound derivation | `c1_controls_claim_` + first 40 hex SHA256 of `R:workspace:seat-name` (scripts/live-ordinary-controls.mjs:37 at final R) | HezLead | Wrong workspace/name/hash input or fresh id on same-pass retry | `$F05_EVIDENCE/I1-controls-request.json` | Producer recalculates with the recorded pass and workspace |
| Revoked other-owner name refusal: historical old seat name; measure owner/name history | New per-pass name avoids old-owner hold; revocation does not free that name for another owner (src/protocol/hosted-authority.ts:367–370 at final R; GAP §4) | HezLead | Reusing held name or treating revoke as release of name | `$F05_EVIDENCE/I1-name-hold.json` | Exact-name principal/owner receipt before claim; preserve typed refusal |
| Smoke workspace UUID: already `C1_SMOKE_WORKSPACE_ID`; measure full existing UUID | `<MEASURED:smoke-workspace-uuid>` agrees with C1 inputs (C:7669–7697 at final R; GAP §4) | HezLead | Historical UUID, missing workspace or wrong input | `$F05_EVIDENCE/I1-smoke-id.json` | `ai-w6-client-check`, C:7922–7929 |
| Smoke workspace name/role: already `C1_SMOKE_WORKSPACE_NAME`; measure exact name and owner membership | Exact name and `role='owner'`, `revoked_at IS NULL` for measured human (C:7925 at final R) | HezLead | Name mismatch or member-only/revoked access | `$F05_EVIDENCE/I1-smoke-owner.json` | `ai-w6-client-check` queries both workspaces and memberships |
| Owner state root: old default `~/.cswarm/credentials.d`; measure explicit root, target and session | Canonical owned 0700 `OWNER_STATE_ROOT`, protected `.cswarm/credentials.d`, production target (C:7617–7626,7651–7667,7688–7691 at final R; ruling 23) | HezLead | Empty/relative/symlinked/real-home/ancestor root, wrong mode/owner, absent credentials directory | `$F05_EVIDENCE/I1-owner-root.json` | Producer and owner callers validate root before the child; no root deletion |
| Later owner commands: already `c.state_directory`; measure propagated directory/target | Same receipt-bound explicit root in all owner readers (C:7737–7744,7993,8446–8455 at final R) | HezLead | Default-store fallback or changed target/root | `$F05_EVIDENCE/I1-owner-readers.json` | Each owner command compares C1 inputs; only bounded revoke child receives its HOME override |
| Fixture owner/workspace: `fixture-login.sh:23–24` old `WS=c2ea0541…`, `USER=d37e2ff2…`; measure synthetic owner/workspace/live role | Required inputs equal the signed synthetic record; production credentials absent (external fixture-login.sh:23–24; P:117,272) | HezLead, C1 staging owner alone | Unexpected pre-edit bytes, old literal, unset success, record mismatch | `$F05_EVIDENCE/I1-fixture-edit/` | Procedure below; live staging owner-role readback before login |
| Fixture smoke UUID/name: `run-w6.sh:28–29` old UUID/`C1 control fixture` fallbacks; measure synthetic UUID/name/owner role | Required smoke inputs equal the signed synthetic record (external run-w6.sh:28–29; P:272) | HezLead, C1 staging owner alone | Remaining fallback, stale lines, unset success or wrong role/name | `$F05_EVIDENCE/I1-fixture-edit/` | Procedure below; compare assignments and live readback before W6 |
| Staging controls/warm-up: `run-w5.sh:215,236–246`, `driver.py:393`; old `6851418d…`, `c2ea0541…` and identity comments; measure synthetic targets | Required measured controls/warm-up inputs, no historical literal/default in future-run code (GAP §4; P:117) | HezLead, C1 staging owner alone | Old literal/unchecked default or wrong synthetic target | `$F05_EVIDENCE/I1-kit-consumers/` | Signed source-to-derived diff and pre/post hashes of every affected script before rehearsal |

Owner state handling uses ruling 23's single-child exception only. Never assign the shell's HOME, copy the site profile into staging, or run HOME-override tests unsandboxed on the mini. The revoke path deletes at most its named credential file; it does not recursively delete the root (C:7640–7642,8455 at final R). [ruling 23; WORKER-RULES]

## Staging owner procedure — I1c

1. HezLead measures a nonsecret synthetic record on the admitted staging target: `synthetic=true`, host, UTC measurement time, owner UUID, fixture workspace UUID, smoke workspace UUID/name, live unrevoked owner-role proof for each, controls/warm-up workspace identities, and whole-file `pre_sha256` for each kit consumer above. HezLead signs it. Use `<MEASURED:record-path-and-sha256>`; absence or an obsolete reset record STOPs. No maker edits the kit. [P:117,272; GAP §4]

2. The following commands are for HezLead's later Mac edit as C1 staging owner, after live identity measurement. `SYNTHETIC_RECORD`, `SYNTHETIC_RECORD_SHA256` and `F05_EVIDENCE` must name the signed receipt, its reviewed digest and a private evidence root. This block verifies exact pre-edit lines and whole-file hashes before either edit. It saves both before/after files and their diff. Any exception once the first write is attempted restores BOTH saved `.before` files, verifies both original SHA256 hashes, then STOPs. `hashes.json` is written only after both edits succeed. All derived assignments require inputs without defaults. [external fixture-login.sh:23–24/run-w6.sh:28–29; P:117,272; GAP §4]

```text
set -euo pipefail
umask 077
: "${SYNTHETIC_RECORD:?STOP missing measured record}" "${SYNTHETIC_RECORD_SHA256:?STOP missing record digest}" "${F05_EVIDENCE:?STOP missing receipt root}"
python3 - "$SYNTHETIC_RECORD" "$SYNTHETIC_RECORD_SHA256" "$F05_EVIDENCE" <<'PY'
import hashlib,json,pathlib,difflib,re,stat,sys
record=pathlib.Path(sys.argv[1]); raw=record.read_bytes()
assert record.is_absolute() and record.resolve(strict=True)==record
assert stat.S_IMODE(record.stat().st_mode)==0o600
assert hashlib.sha256(raw).hexdigest()==sys.argv[2], 'STOP record digest'
d=json.loads(raw)
assert d['synthetic'] is True and d['measured_at'] and d['host'] and d['hezlead_signature']
for k in ('owner_user_id','fixture_workspace_id','smoke_workspace_id'):
    assert re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',d[k])
    assert not d[k].startswith(('56b40671','919ce195','c2ea0541','d37e2ff2'))
assert d['smoke_workspace_name'] and d['smoke_workspace_name']!='C1 control fixture'
for k in ('fixture_owner_role','smoke_owner_role'):
    assert d[k]=={'role':'owner','revoked':False}
root=pathlib.Path(sys.argv[3]); assert root.resolve(strict=True)==root
assert root.is_dir() and stat.S_IMODE(root.stat().st_mode)==0o700
out=root/'I1-fixture-edit'; out.mkdir(mode=0o700)
kit=pathlib.Path('/Users/yulanbot/work/c1-verify/staging-run')
changes=[('fixture-login.sh',23,[
 'WS=c2ea0541-f56d-4c73-bf71-56c5405c4934',
 'USER=d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc'],[
 'WS=${C1_FIXTURE_WORKSPACE_ID:?STOP missing measured fixture workspace}',
 'USER=${C1_SYNTHETIC_OWNER_ID:?STOP missing measured synthetic owner}']),
 ('run-w6.sh',28,[
 'SMOKE_ID=${C1_SMOKE_WORKSPACE_ID:-c2ea0541-f56d-4c73-bf71-56c5405c4934}',
 'SMOKE_NAME=${C1_SMOKE_WORKSPACE_NAME:-C1 control fixture}'],[
 'SMOKE_ID=${C1_SMOKE_WORKSPACE_ID:?STOP missing measured smoke workspace}',
 'SMOKE_NAME=${C1_SMOKE_WORKSPACE_NAME:?STOP missing measured smoke name}'])]
prepared=[]; rows=[]
for name,start,old,new in changes:
    p=kit/name; assert p.resolve(strict=True)==p and p.is_file()
    before=p.read_bytes(); h=hashlib.sha256(before).hexdigest()
    assert h==d['pre_sha256'][name], 'STOP stale pre-edit hash'
    lines=before.decode().splitlines(keepends=True)
    assert [x.rstrip('\n') for x in lines[start-1:start+1]]==old, 'STOP stale pre-edit lines'
    lines[start-1:start+1]=[x+'\n' for x in new]; after=''.join(lines).encode()
    assert not any(x in after for x in (b'c2ea0541',b'd37e2ff2',b'56b40671',b'919ce195',b'C1 control fixture'))
    (out/(name+'.before')).write_bytes(before)
    (out/(name+'.after')).write_bytes(after)
    (out/(name+'.diff')).write_text(''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile=name+'.before',tofile=name+'.after')))
    prepared.append((p,before,after))
    rows.append({'file':name,'pre_sha256':h,'post_sha256':hashlib.sha256(after).hexdigest()})
write_started=False
try:
    for p,before,after in prepared:
        assert p.read_bytes()==before, 'STOP concurrent kit edit'
        write_started=True
        p.write_bytes(after)
        assert p.read_bytes()==after, 'STOP post-edit mismatch'
    (out/'hashes.json').write_text(json.dumps({'record_sha256':sys.argv[2],'files':rows},sort_keys=True)+'\n')
except BaseException as exc:
    failures=[]
    if write_started:
        for p,before,after in prepared:
            try:
                saved=(out/(p.name+'.before')).read_bytes()
                assert hashlib.sha256(saved).hexdigest()==d['pre_sha256'][p.name]
                p.write_bytes(saved)
            except BaseException:
                failures.append(p.name+' restore')
        for p,before,after in prepared:
            try:
                assert hashlib.sha256(p.read_bytes()).hexdigest()==d['pre_sha256'][p.name]
            except BaseException:
                failures.append(p.name+' original SHA256')
    if failures:
        raise SystemExit('STOP kit recovery failed: '+', '.join(failures)+'; no rehearsal; HezLead must restore both originals') from exc
    raise SystemExit('STOP kit edit failed; both originals verified if a write was attempted; no rehearsal; hashes.json is invalid') from exc
PY
```

3. HezLead completes and reviews the controls/warm-up changes in the table as a separate source-to-derived diff. In particular, `run-w6.sh:175,395` still has the old controls workspace; the primary two-line edit does not admit those calls. Save pre/post whole-file hashes and update the primary receipt with the final file hash. Any old literal, fallback default, extra unreviewed hunk or production target STOPs the entire rehearsal. [GAP §4; external run-w6.sh:175,395; ruling 40(6)]

4. Prove missing-input refusal in isolated assignment snippets, without starting either kit script or contacting a service. Then export measured inputs from the signed record in the rehearsal's own shell and compare them with fresh live owner/name readbacks; record the positive and negative results and the final diff signature. Never infer live membership from the JSON alone. [P:272; C:7925 at final R]

```text
set -euo pipefail
KIT=/Users/yulanbot/work/c1-verify/staging-run
python3 - "$KIT" "$SYNTHETIC_RECORD" <<'PY'
import json,pathlib,subprocess,sys
k=pathlib.Path(sys.argv[1]); d=json.load(open(sys.argv[2]))
checks=[('fixture-login.sh',23,{'C1_FIXTURE_WORKSPACE_ID':d['fixture_workspace_id'],'C1_SYNTHETIC_OWNER_ID':d['owner_user_id']},'test "$WS" = "$C1_FIXTURE_WORKSPACE_ID"; test "$USER" = "$C1_SYNTHETIC_OWNER_ID"'),
 ('run-w6.sh',28,{'C1_SMOKE_WORKSPACE_ID':d['smoke_workspace_id'],'C1_SMOKE_WORKSPACE_NAME':d['smoke_workspace_name']},'test "$SMOKE_ID" = "$C1_SMOKE_WORKSPACE_ID"; test "$SMOKE_NAME" = "$C1_SMOKE_WORKSPACE_NAME"')]
for name,start,values,verify in checks:
    code='set -eu\n'+'\n'.join((k/name).read_text().splitlines()[start-1:start+1])+'\n'+verify
    for missing in values:
        e={x:v for x,v in values.items() if x!=missing}
        assert subprocess.run(['/bin/bash','-c',code],env=e,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0, 'STOP unset input succeeded'
    assert subprocess.run(['/bin/bash','-c',code],env=values,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0, 'STOP measured-input positive control failed'
print('PASS isolated assignment controls; live owner-role recheck still required')
PY
C1_IDENTITY_EXPORTS=$(python3 - "$SYNTHETIC_RECORD" "$SYNTHETIC_RECORD_SHA256" <<'PY'
import hashlib,json,shlex,sys
raw=open(sys.argv[1],'rb').read()
assert hashlib.sha256(raw).hexdigest()==sys.argv[2], 'STOP changed identity record'
d=json.loads(raw)
for name,key in [('C1_SYNTHETIC_OWNER_ID','owner_user_id'),('C1_FIXTURE_WORKSPACE_ID','fixture_workspace_id'),('C1_SMOKE_WORKSPACE_ID','smoke_workspace_id'),('C1_SMOKE_WORKSPACE_NAME','smoke_workspace_name')]:
    assert isinstance(d[key],str) and d[key], 'STOP missing measured input'
    print('export '+name+'='+shlex.quote(d[key]))
PY
) || { printf 'STOP measured identity export refused\n' >&2; exit 1; }
eval "$C1_IDENTITY_EXPORTS"
```

## W1 — reconcile 7Rh7NR once, before W4

HezLead is the sole administrative closer. Stop other work on 7Rh7NR first. Supply its original W5 inputs/site evidence/private prep, the reviewed plan and the six-key approval (`approver`, `action`, original `release_sha`, `window_id=7Rh7NR`, current `plan_sha256`, `prompt_ref`). Reason is exactly `owner-retired-seat-name-held`. Approval must bind the current reviewed close plan, while historical inputs retain their original hash. No released W5 enters the rolled-back recovered-close branch. [C:9521–9537,9573–9620 at final R; P:118]

The later operator runs this in a dedicated Mac `/bin/bash` shell. `PLAN_FILE` must be a verified byte-for-byte copy of C at the explicit reviewed pin; the existing close body is lines 9576–9697 inclusive. Changed bytes or line anchors require a reviewed update, never automatic discovery. No command below runs during fragment preparation. [C:9576–9697 at final R]

```text
set -euo pipefail
: "${PLAN_FILE:?STOP missing reviewed close plan}" "${W5_INPUTS_FILE:?}" "${W5_SITE_EVIDENCE:?}" "${W5_PREP_DIR:?}" "${W5_ADMIN_APPROVAL_FILE:?}"
export W5_INPUTS_FILE W5_SITE_EVIDENCE W5_PREP_DIR W5_ADMIN_APPROVAL_FILE PLAN_FILE
export W5_ADMIN_REASON=owner-retired-seat-name-held
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["window_id"])' "$W5_INPUTS_FILE")" = 7Rh7NR
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm
cmp "$PLAN_FILE" <(git -C /Users/yulanbot/work/c1b-lanes/integration show 2e2ac5e63e851cc84f345a65b3547de365e8ea2e:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md)
sed -n '9576,9697p' "$PLAN_FILE" | /bin/bash
```

Retain `closed-administrative.json`, approval digest, site CLOSE/manifest paths and hashes, preserved pre-W1/BEFORE receipts and the disposition log. Record `<MEASURED:parked-marker-path/status/disposition>` and `<MEASURED:grants/principals/expiry-or-revoke/residue>`. Administrative close does not clear the parked marker, revoke credentials or prove residue absent. Do not repeat the close if cleanup refuses after the record exists; leave the record and prep and report the exact guard refusal. [C:9541–9570,9674–9697 at final R]

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| 7Rh7NR original inputs, site released outcome, archive/manifest hashes, explicit approval and administrative record | One `closed-administrative`, exact reason, original window binding; forward `closed.txt`/`W5-closed.json` absent (C:9613–9620,9674–9684 at final R) | HezLead | Missing/mismatched evidence, another closer or an existing close record | Original W5 evidence root's `closed-administrative.json`; `$F05_EVIDENCE/W1-disposition.json` | Re-read approval/hash/retained evidence and marker disposition before W4 admission |
| Old controls grant/principal and parked marker disposition | Measured revocation/expiry or explicit accepted residue; name hold retained (C:9541–9570 at final R) | HezLead | Unmeasured residue or treating administrative close as W6 readiness | `$F05_EVIDENCE/W1-disposition.json` | Fresh R W5 must independently close forward and produce fresh browser readiness (C:6786–6833 at final R) |

## Pass order and freeze

Follow **W1 → R landed → OAuth → backup-only install → U7 → U rows → W4 → W5 → X2 staging before W6 admission → W6 → W7**. U7 is listed separately for dependency clarity; the remaining U rows include U9's staging second-W4/keeper/failure proof and U10. All U rows must PASS before production W4. Each window finishes its box and Mac close before the next window begins. [TASK-l5-F05; P §3/§5 Q3,Q8,Q12,Q14,Q16; rulings 2,6,19,40]

1. If W1 opens a window, run the Window admission fence first. Finish W1 reconciliation above. Set the production date, start the freeze and land reviewed build B at full R; HezLead records `<MEASURED:R/landing-time/review-PASS/CI-receipts>`. Require five green suites (server, p1-cli, site, box-dry-run, unit) and R-bound X2 CI proof; no worker dispatches them. An integration head is not a landed release. [P §3; rulings 2,40(6)]
2. Run the Window admission fence before the OAuth window opens. Release OAuth to R only through O's reviewed order, retaining its closed-gate probes and close receipt. OAuth does not prove the database fence or archive binding. W4 owns edge → R; never preinstall an R edge tree ahead of W4. [O:3–17,68–79 at final R; C:4338–4339 at final R; FEAS §5]
3. Run the Window admission fence before the backup-only/U7 window opens. Install the **whole reviewed `deploy/supabase-stack/backup/` from R** in a new immutable backup-only directory with SHA256 manifest and the Docker-visible verify-counts path. Root 0644 systemd drop-ins repoint only backup/drill units; daemon-reload. Keep ec098859 immutable; no section 9/API_CADDY_PAIR stack install or Caddy edit. Record Caddy before/after hashes (must be unchanged), unit/timer/drop-in before/after hashes, all installed R-byte hashes and reviewed differences. Rollback removes only owned drop-ins, then daemon-reload. Require one manual backup plus drill PASS with commonswarm_ops and checksum rows >0 before U7. Exact install commands are F02's reviewed operator block; no substitution is admitted here. [rulings 17,19,40(4) and its amendment; FU #31]
4. HezLead signs U7's fresh verified backup and real isolated restore identity/time/schema checksum/key-table counts against the source. U9's staging status does not count. Read ruling 42's restore status JSON from the one manual backup plus drill; require the source/target checksums with named algorithm and named key-table counts. For U9, first admit standalone ARCH 15A–15C with the Window admission fence, finish its signed receipts before W4X take/A1, then run the SAME Window admission fence separately for the one local-only dump/drill/status sequence in steps 16–17 under rulings 53(a)/54 before any W4 case. Its planned open and planned end must both PASS before step 16 starts, with completion before the admitted end and the next recycle :30; close that step's signed receipt before the next case admission. Run that same fence separately before every U9 case and take exclusion before A1. Complete U1–U6/U8–U10 and their execution rechecks before W4; keep all unmeasured values as STOP. [rulings 7,19,40(4) amended,42; P:101–110]
5. Run the Window admission fence before production W4 opens; obtain a separate admission before new W5 opens after W4 close. Before production W4, require Tom's dedicated W4 check/config step and reviewed dispatch; W4 preflight STOPs without it. Take durable exclusion before A1, retain through all recovery, enforce 1536 MiB/6 h independent STOP alert and HezLead rollback-aware recycle response, verify G6 baseline-approval receipt after rollback, then release exclusion only after the terminal record (C:4340–4349,5851–5857,5904–5916,6010–6033,6083–6110,9285–9297). Run W4 with keeper adoption digest equality, receipt/VARS/live-baseline equality, pinned INSTALL excerpts and retirement before binding moves. On rollback keep durable state and keeper RETIRED; record **"keeper retired; re-install required before reboot"** and **"no reboot"** until HezLead's fresh INSTALL §§1–3 receipt before reboot/retry. Never re-install automatically. Finish W4 forward close, then new W5 forward close at R with the same-release consent chain. [rulings 11–14; C:150,2081,349–360,408 at final R]
6. Run the Window admission fence before each X2 staging variant window opens, then separately before W6 opens. Before W6 admission, obtain distinct CI and staging X2 receipts with exact T/R/test/migration-tree bindings. Staging owner follows F04 and rulings 18/20's online-backup isolation, per-run fresh dump/restore within 60 minutes and guarded cleanup. Require the final 15 source-derived names/classes: 1 positive control, 12 base-cycle, 2 regression-guard. Positive-control test PASS and exactly one raw-SQL 40P01 on T and R; base-cycle FAIL-40P01 at T/PASS at R; regression-guard PASS at both. Preserve controls arrays plus sibling `x2_race_classes` from exported `X2_RACE_CLASSES`; require the independently reviewed validator amendment. Final R contains the reviewed amendment: rule 8 requires FAIL-40P01 only for base-cycle at T and PASS for regression guards/positive control at T and every result at R. [rulings 37(c),40(1–3,7); C:1869–1975, specifically C:1944–1946; F04/contract receipts must supply final R execution evidence]
7. Require the W6 Window admission receipt before open; run the same fence separately before W7 opens. W6 runs the separately assigned owner approval/consent/fence/withdraw/revoke sequence; real provider consent belongs to Tom's production steps, staging uses mock GitHub. Before any keep-open finish that admits others, enforce #50 below. W7 binds the successful W6 C1 receipt and measured OPEN/CLOSED state; finish W7 box close, then Mac close and the pass log. End the freeze **only after W7 Mac close**. [C:152–153,450–486,568–575,9499–9518 at final R; rulings 5,37(b); FEAS:208,218]

The freeze prevents unrelated site/edge/OAuth releases, Caddy edits, schema/ACL changes, hook upgrades and recycle-reference rebindings. Permit reviewed C1 actions and normal recycling outside timer-hold periods. An interruption does not end the freeze; HezLead resolves recovery and records close receipts. [rulings 2,6,11; FEAS:218]

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| Ordered close/install/U/X2 receipts, R identity and freeze start/end | Exact order above; U7/U rows PASS; W7 Mac cleanup proved absent before freeze release (rulings 19,40; C:9499–9518 at final R; FEAS:208) | HezLead; assigned release worker executes | Missing receipt, wrong R, premature window/admission or premature freeze end | `$F05_EVIDENCE/pass-order.json` and operator `LOG.md` | Compare window inputs/receipt digests before each admission; W7 Mac-close absence check last |

## #35, Lane 2 closure and the #50 gate

The supplied historical #35 receipt is `/Users/yulanbot/work/c1-verify/review/FU35-deadlock-measure-20261010T1424Z.txt`: HezLead's yulan-vps-1 read at 2026-10-10 14:24Z, available interval 2026-10-03T14:28:39Z..2026-10-10T14:21:02Z, 9336 lines. Deadlocks **0**, lock-timeout statements **0**, serialization failures **0**. Its same-stream positive control is **15 ERROR**, with FATAL 746, LOG 6087 and permission-denied 4. This shows no logged occurrence in that interval. It does not prove the source cycle absent and is not a fresh dispatch measurement. [FU35 receipt; P:69; ruling 9; FU #35]

For a fresh read, HezLead alone runs this later on the admitted host, with `PG_CONTAINER=<MEASURED:admitted-postgres-container>`. It streams a bounded seven-day window, reports counts/timestamps only, checks Docker's exit through pipefail and never uses exec. Missing coverage or no ERROR positive control cannot support a zero-occurrence conclusion. [ruling 9; FU35 receipt]

```text
set -euo pipefail
: "${PG_CONTAINER:?STOP unmeasured Postgres container}"
date -u '+read_at=%Y-%m-%dT%H:%M:%SZ'
docker logs --timestamps --since 168h "$PG_CONTAINER" 2>&1 | python3 -c 'import sys; first=None; last=None; n=0; c={"deadlock detected":0,"canceling statement due to lock timeout":0,"could not serialize":0,"ERROR:":0};
for line in sys.stdin:
 n+=1; stamp=line.split(" ",1)[0]; first=first or stamp; last=stamp
 for key in c: c[key]+=int(key in line)
print("first_timestamp="+str(first)); print("last_timestamp="+str(last)); print("lines="+str(n))
for key,value in c.items(): print(key+"="+str(value))'
```

| deciding measurement | expected value (source) | measuring owner | STOP condition | receipt location | execution recheck |
|---|---|---|---|---|---|
| #35 seven-day counts, retained coverage and same-stream ERROR positive control | Historical supplied 0 deadlocks/15 ERROR; fresh result `<MEASURED:counts/coverage/control>`; source cycle still requires X2 (ruling 9; FU35; P:69) | HezLead | Read failure, incomplete coverage or control absent: STOP claiming zero; positive deadlock count: STOP for HezLead's disposition | `$F05_EVIDENCE/FU35-fresh.txt`; retain historical FU35 path | Recheck stream coverage/control together; X2 deterministic raw-SQL control separately proves race harness detection |
| Lane 2 closure and every later cycle's exception analysis | CLOSED after bounded FK audit/review; later cycles go to FU unless added/widened by build B, hang/partial write, or both sides C1 admin issuance traffic (ruling 33; FU final Lane 2 CLOSED entry) | HezLead/CSwarm Lead | Any of those three exceptions blocks C1; unclassified later cycle STOPs for classification | `$F05_EVIDENCE/lane2-closure.json` | Re-read current closure/review receipts and later-cycle disposition at admission |
| #50 admin consent/selection 40P01 handling, rollback and retry proof at landed/released code | SQLSTATE-based typed retryable response, same shape as command edge 503 temporarily_unavailable, with test; landed before issuance beyond owner smoke (ruling 37(b); FU #50) | HezLead; independent reviewer verifies | Generic 500, missing test/rollback/retry proof, not landed or not in serving OAuth: STOP broader issuance | `$F05_EVIDENCE/FU50-gate.json` with landed SHA, test/review and OAuth receipt | Recheck before W6 keep-open/finish and every later opening; no proof means owner-smoke-only then CLOSED |

Ruling 33 closes the Lane 2 search; it does not waive #50. #42-W6S is known only under the closed-issuance W6 condition. Owner smoke is the sole pre-#50 exception; no public/other-client admin issuance or automatic keep-open follows it. #50 landing alone is insufficient if OAuth still serves older bytes. [rulings 25(b),33,37(b); FU #50; O:73–79 at final R]

Acceptance check: reconcile all GAP §4 consumers with the I1 rows; every row has six fields; fixture pre/post digests/diff, unset refusal and measured positive control exist; W1 has exactly one administrative record and explicit residue; pass order/freeze and #35/#50 gates remain STOP until their receipts exist. Fragment drafting ran no operator block or service test. Review/evidence destination: this file and HezLead's F05 review receipt; CSwarm Lead assembles it after Grok review. [TASK-l5-F05; P:272; ruling 40(6)]

# Source catalog retained from the five fragment maps

The alias table above replaces their duplicate base/path prose. Their additional repository anchors are resolved here at final R; external inputs retain their exact paths in the citation appendix. Each source is read as a Git object, not from a lane worktree.

| Scope | Final-R source anchors |
|---|---|
| Section 01 inputs/identity/gates/fence | C:699,1047,770–772,1085–1092,1869–1975,1978; E:788–806; supabase/migrations/20261003000003_admin_oauth_cutover.sql:267,423–499 |
| Section 01 W4 measurement/candidate/keeper/apply/state/W1 | C:4013–4022,4025,4375,4520,4654,4872,5282,5748,9573; DRILL:37–40,242–252; X:74–81,202–210 |
| Section 02 complete backup directory and native proof | BK/run-backup.sh:7–31; BK/dump-database.sh:12–27; BK/commonswarm-postgres-backup.service:7–17; BK/commonswarm-postgres-restore.service:7–17; BK/commonswarm-postgres-backup.timer:5–7; BK/commonswarm-postgres-restore.timer:5–7; BK/README.md:59,120–149; BK/upload-snapshot.py:19–37; DRILL:28,37–40,242–252,272–321,368–380,445–446,481–554 |
| Section 02 adjacent migration helper chain | MIG/dump-source.sh:4; MIG/lib.sh:5–6,302–307; MIG/prepare-target.sh:98–104; MIG/verify-counts.sh:36–55 |
| Section 03 session, backup gate, retirement and recovery | C:82,346–380,1638–1654,1817–1852,1749–1810,2212–2242,4013–4022,4025,4375,4520,4654,4819,4872,4885,5026,5569,5748,6202–6207,8914,9122–9124,9247–9249; BK/dump-database.sh:7–33; BK/make-backup-service.mjs:4–23; DRILL:47–56,481–554 |
| Section 04 source classes, validator and transaction shape | X:74–210; GATES:276–327,363–412; C:1897–1972,1917–1971,3193–3218,7110–7117; deploy/RELEASE-TO-BOX.md:1972–2110 |
| Section 04 Compose/HBA/readiness/restore | STACK/compose.yaml:1–214; STACK/postgres/pg_hba.conf:1–15; STACK/postgres/10-runtime-roles.sh:27–54; BK/dump-database.sh:4–33; BK/make-backup-service.mjs:3–25; DRILL:286–321,368–380; MIG/lib.sh:77–135; MIG/restore-target.sh:27–64; MIG/prepare-target.sh:7–104; MIG/verify-counts.sh:36–70 |
| Section 04 bound harness and SQLSTATE/write/audit/refusal observations | H:23–28,99–193,210–251,543–598,669–670,822,1033,1107–1114,1186–1195,1324–1332,1416–1424 |
| Section 05 window order, controls, owner roots and smoke | C:150–153,349–360,408,450–486,568–575,1869–1975,2052–2081,7617–7697,7737–7744,7922–7929,7993,8446–8455,9499–9518,9521–9697 |
| Section 05 site/OAuth and ordinary controls | SITE:49–50,865–867,900–902,1619,1745,2087,2130,2670–2672; O:3–17,68–79; scripts/live-ordinary-controls.mjs:33,37,201–202; src/protocol/hosted-authority.ts:367–370 |

Assembly evidence and full placeholder-owner register: [CITATIONS.md](CITATIONS.md). Runtime signature/measurement omissions remain STOP prerequisites; the source citation check itself has no unresolved repository or external anchor.
