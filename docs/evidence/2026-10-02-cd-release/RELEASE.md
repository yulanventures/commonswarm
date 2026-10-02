# C+D administration: schema then ON edge release

Prepared, **not executed**. HezLead reviews this plan, supplies the landed merge
SHA of this lane as `RELEASE_SHA`, and separately approves the production window.
The source tree under that merge must retain the runtime inputs inventoried below.
The starting main is `e81c77a4bd80a1f551a3cc1c32216e128a96a7cb`.
The plan archives the final merge, including these proofs; it never archives an
uncommitted worktree or substitutes this preparation commit for the release input.

HezLead's October 2 handoff: edge `65a6caf0f03066d60a18591fca3a370ecc59744d`,
OAuth `00e89738` ON, stack `ad964ed1`, site `603a206e`, hosted MCP ON.
C+D implementation `ee077a0d083fe9d18efbf47422efed5dbbf55bde` landed via
`cda775f4`; it is not live. These are supplied facts, not worker measurements.
Main is a superset of the live SHAs. No OAuth/service, stack-container, site,
image, secret value, or persistent environment change is part of this release.

Use [release procedure §§1,5,6](../../../deploy/RELEASE-TO-BOX.md),
[HM37 migration/backup pattern](../2026-09-28-box-hm37/BOX-WINDOW.md), and the
[generalized ON edge plan](../2026-10-02-edge-mcp-release/RELEASE.md).
The host runbook remains authoritative. Only the assigned release worker runs
these marked blocks after HezLead's separate authorization. Extract whole blocks
by step ID; no commands invented from prose during the window. No GUI/browser,
keychain, HOME assignment, Actions dispatch, network package installation or
Docker image pull. A failed block stops forward work immediately.

Keep one Mac Bash 3.2 shell for the archive/transport/cleanup nonsecret values.
Box blocks reload their per-window state in each fresh root invocation.
Mac blocks require Bash 3.2 and Python 3; box blocks require root Bash 5.2,
Python 3.12 (tar data filter), Node, the already-cached PostgreSQL 17 image and
noninteractive root SSH through ops. `%q` transports only nonsecret inputs.
Existing protected box inputs suffice; no 1Password call is needed. Credential
recovery would be a separate task using the service-account token file only.
All newly staged secret files live in a fresh mode-0700
`mktemp -d /private/tmp/anvil-secret.XXXXXX` directory, mode 0600 files, removed
at close or abort. Never print an env, connection string, secret, body, or raw log.
Mac cleanup uses guarded `rm`; box `/usr/bin/rm` requires exact-path checks.
If any deletion is refused, leave the path and report the exact guard message.

## Release inventory

Computed from `git diff 65a6caf0..e81c77a4` for the four requested surfaces;
this lane changes only plan/proof inputs. `cd-archive` refuses later runtime
changes unless this inventory and review are redone. Every carried first-parent
commit follows below, including history absent from the hotfix branch's own
ancestry. A lane merely present in an archive is not necessarily a live change.

All six edge functions change: **command, read, capability, activity, h0, mcp**.
Command adds account grants/credential runtime and routine workspace adapters,
worker-scope extraction, and safe admin diagnostics. Read adds the human-only
recovery adapter and generated validation contract. Capability/activity/H0/MCP
reject foreign admin credentials before their ordinary paths. Shared protocol
and admin/event declaration bundles change. The MCP initialize hotfix from
65a6caf0 remains carried; ordinary hosted MCP tools remain the existing tools.

`deploy/edge-runtime/compose.override.yaml` is new in the archive (`mem_limit: 2g`);
the ON edge plan accepts it only byte-equal to the live override. No compose.yaml,
router, bootstrap, image, or network delta. Stack archive differences are the
Caddy `/authorize/*` routing and `GOTRUE_URI_ALLOW_LIST` example's `**` suffix;
these were carried by OAuth/allowlist lanes and are **not applied** by this plan.
The existing live Caddy site is preserved byte-for-byte by the ON edge plan.
`git diff 00e89738..e81c77a4 -- services/mcp-auth deploy/mcp-auth` is empty:
**NO OAuth release**. Site/CLI/doc lanes carried below are not deployed here.

| Version | Migration | Added / modified state |
| --- | --- | --- |
| 20261001000001 | admin_delegation | Eight private account/grant/consent/credential/event/result/rate/audit tables; RLS, grants, indexes, append-only triggers. |
| 20261001000002 | admin_routine | Routine invitations/created-workspaces; nullable event/principal/token ancestry; parent checks, restrictive SELECT policy and triggers; routine projection initialization. |
| 20261001000003 | admin_recovery_read | Human-claims recovery page definer; only swarm_read may execute. |
| 20261001000004 | admin_worker_read_fence | Replace agent_delivery_read_context in place; fresh parent/scope checks before private reads or first use; scopes helper STABLE→VOLATILE. |
| 20261001000005 | admin_routine_workspace_history | Narrow workspace/grant/stream replay definer, command EXECUTE only; raw events remain INSERT-only. Removes obsolete view if present. |

Environment: literal `Deno.env.get` inventories on both trees add **zero names**,
remove **zero names**, and have no changed defaults for environment reads.
`SWARM_ENV` already exists in the baseline command/read/MCP/capability code and
router's per-function forwarding lists. It is optional, absent from
`deploy/supabase-stack/env.example`, declared blank in the edge env example;
compose passes `/home/commonswarm/.env` as env_file without supplying a default.
HM37 §2's September 28 measurement explicitly says live SWARM_ENV was omitted.
**Current live presence is NOT PROVED** (SSH is forbidden for this prep task).
`cd-preflight` records presence only from live inspect and canonical env-file
names; it requires consistent presence and, if set, an approved production
classification (`production`), rejects `test` and all `SWARM_CMD_TEST_*` names.
Missing remains valid. Do not add SWARM_ENV as part of this window. The edge
plan checks all effective environment key/value digests against this baseline.

Generated freshness: `npm run build:command-core` (includes build-admin-types)
and `node supabase/functions/read/build-admin-recovery.mjs` both produced **no
diff** in supabase/functions during preparation. Exact-release gate evidence is
still required for the final merged RELEASE_SHA.

### Complete changed-path inventory

```text
A	deploy/edge-runtime/compose.override.yaml
M	deploy/supabase-stack/commonswarm-mcp.caddy
M	deploy/supabase-stack/env.example
A	supabase/functions/_shared/admin-authority.d.ts
A	supabase/functions/_shared/admin-credential-boundary.ts
A	supabase/functions/_shared/admin-policy.d.ts
A	supabase/functions/_shared/admin-routine-events.d.ts
A	supabase/functions/_shared/admin-routine.d.ts
A	supabase/functions/_shared/events.d.ts
M	supabase/functions/_shared/protocol.js
A	supabase/functions/_shared/workspace-events.d.ts
M	supabase/functions/activity/index.ts
M	supabase/functions/capability/index.ts
A	supabase/functions/command/admin-delegation.ts
A	supabase/functions/command/admin-routine-workspace.ts
A	supabase/functions/command/admin-routine.ts
A	supabase/functions/command/admin-runtime-auth.ts
M	supabase/functions/command/failures.ts
M	supabase/functions/command/index.ts
A	supabase/functions/command/worker-scopes.ts
M	supabase/functions/h0/forward.ts
M	supabase/functions/h0/poll-ack.ts
M	supabase/functions/mcp/index.ts
A	supabase/functions/read/admin-recovery-contract.ts
A	supabase/functions/read/admin-recovery.sql
A	supabase/functions/read/admin-recovery.ts
A	supabase/functions/read/build-admin-recovery.mjs
M	supabase/functions/read/index.ts
A	supabase/migrations/20261001000001_admin_delegation.sql
A	supabase/migrations/20261001000002_admin_routine.sql
A	supabase/migrations/20261001000003_admin_recovery_read.sql
A	supabase/migrations/20261001000004_admin_worker_read_fence.sql
A	supabase/migrations/20261001000005_admin_routine_workspace_history.sql
```

### Every carried first-parent commit / lane

```text
e81c77a4bd80a1f551a3cc1c32216e128a96a7cb Merge lane/hm37-edge-release-fix (c645f3827bf139ff43bca0d46d2835c5cdd15aff): HezLead dispatcher request
10f4f8421fcbd094fa18f76aadb65c6883af13d8 Merge lane/hm37-edge-release (1efb4aa1d65cb8006bd582fbf13f8bbde9418f11): HezLead dispatcher request
4d6705ced3b77c67881cf6fb46e0c4af15e08b47 Merge lane/hm37-mcp-initialize (41b2ed612131d2d7f017466b9c13958940089992): HezLead dispatcher request
48cd7379836e546d41856e90893884bec48773d3 Merge lane/hm37-mcp-initialize-hotfix (65a6caf0f03066d60a18591fca3a370ecc59744d): HezLead dispatcher request
00e8973892f8ab43e6ddb81882e612dac51ca0bb Merge lane/hm37-oauth-token (531ad2c8e398944611165ab4b70d302cf56941f3): HezLead dispatcher request
6c85221296e8a47a89cebdf0c59d926dfe366e2b Merge lane/hm37-oauth-formaction (676afa157cf1aa0c2bc7038fb226c0b3dbc2c684): HezLead dispatcher request
08dbef8a9da9aa458fe960ee8ab73e52f4be7997 Merge lane/hm37-oauth-consent (9d7551131a71ff58fbf3d47636877e9a40a2196b): HezLead dispatcher request
48a0209204a29f8161ff1403c45df4b57a6cb8be Merge lane/hm37-site-windowmode (cc18829b92426647380912b8fe2caea63e568b5b): HezLead dispatcher request
f292a44696ac10421ec75dc17e63497f3e7ec2fb Merge lane/hm37-oauth-origin (288975aefc3ea96de06891765d346ca1302e4636): HezLead dispatcher request
ae18344a80d10a20c8416961ee1aa2c6a23026b1 Merge lane/hm37-site-close2 (e62ac415f9957508a784516580d445c0e358c5d5): HezLead dispatcher request
7b0dd308295cba31a5c8a3103634a7204cdd5840 Merge lane/p6b-c3po-v2-deltas (8a45d037ed9204278ef6ca3fefd6f8071b806d9f): HezLead dispatcher request
f003ec5638704b17e7401d878cdaf86205c4c380 Merge lane/hm37-oauth-authorize500 (b4f1e61f7cb719809f629a9b74900d67cfb18936): HezLead dispatcher request
670ce333861eb86fa592e4b2c3ea06caa6a4456a Merge lane/hm37-site-chromium (f6fc35faa294ec6002a49a41f916f3d4f8915180): HezLead dispatcher request
7323c1aa9b47a38ee9ae07b50c0651b3b16f3ceb Merge lane/p6-onboarding-distribution (368b94bfd5c3f3de4b343b977423fcf5dbcd18b7): HezLead dispatcher request
82beb47c4257e93e6db0d121f1974e0dd54e0d7e Merge lane/hm37-oauth-binding (4c4cc658cea12f73304f3765bff44ac3f1cf4f3b): HezLead dispatcher request
cda775f405e4072a21a80daa846df29aba555d9c Merge lane/cd-admin-integ-r6 (ee077a0d083fe9d18efbf47422efed5dbbf55bde): HezLead dispatcher request
1a22dc4b876d58c1962a8908fea58bed0b4b5bc1 Merge lane/p5b-dot-mcp-events (89fb9ac31160f47bd15a95476e25390cc38d785c): HezLead dispatcher request
939dda22be3d2292f51cb0514a35aad3fa88c64e Merge lane/hm37-site-iso (549f5d53040a119472f374dc672fdb907d4cc7e1): HezLead dispatcher request
011051e2e3e1868c89d37ac9e5f567ab8a90a340 Merge lane/hm37-caddy-resume (55de996e20748e0cae6ce35081b0bea81c7073c7): HezLead dispatcher request
94008475e59a2b35315e73d46d01c62aa82d543c Merge lane/hm37-gotrue-allowlist (25958622)
96a8f058f048a26edd02ba2901b4feed55b46593 Merge lane/hm37-site-close (82efb0f6)
2bd1e235f66ff6d51e9a8bb82a364528897c3361 Merge lane/hm37-oauth-onbase (2b8f53be): OAuth release procedure for an ON baseline (transition-off, 503 receipt, restore-on)
d3ea3c6350205967a465f9802aa258eb624736f0 Merge lane/hm37-oauth-alg (f2962bf3): client defaults use ES256 so Claude CIMD/DCR registration is accepted; container test builds from the repo root
a2760b550a1244d03ab0fd53266cd156b41b586a Merge lane/hm37-site (8a9596ae): lane 8 site release plan pinned to 603a206e, MCP-ON gate, signed-out panel selector
603a206e52f363cff74127d6143c5fcd3ec2770a Merge lane/hm37-oauth (93b466be): ON probes accept the HTML authorization error page; named probe failures
c90c3f7744d073ee7b46444cfbd31edd0d547680 Merge lane/hm37-oauth (815dcb62): drop the auth.uid() text-lookup checks; keep the behavioral swarm_read SELECT checks
b756be07b6996063a09d0b72f578b5df07cc68cf Merge lane/hm37-oauth (76af778f): sslmode=verify-full accepted, REQ-named enable checks, baseline inputs for the rerun
972df1715c84b0ecba1a5c5e81c2b46f7232400d Merge lane/hm37-oauth (8fd6f898): OAuth release procedure reconciled with the live box
376a4a01464e373e7cdd8744cae1f59907ff14d4 Merge lane/hm37-oauth (5eb903fc): OAuth entrypoint composes the lane-2 bindings; MCP switch-on release procedure
1863c533a12983628f790671b44df3c88539b0f3 Merge lane P5: OpenAI Dot agents design (docs)
8434492c363628028c946972659672b9b0fc8872 Merge lane/site-scroll-control-fix2: table scroll control tolerates 1px Linux rounding
68a0d2a6715bfb4c874655cda6a4c490eea5baae Merge lane/hm37-integ (1159a3ec): TLS servername for host-side DB clients in window B and the hosted control
2297f071cba05a78b18a51564331b81cb31666f4 Merge lane B: delegated admin grant authority (47f99eb9)
dc3814c508ceb5f41ef27f0ac6b957dd115e3feb Merge lane/hm37-integ (98394868): HM37 window principal suffix producer fix
311b040f701cfd958e97d6a7a418f8f0ea0e4c56 Merge lane/hm37-integ (941f9b25): HM37 close-resume catalog read prints its result
a6d9cf4e5ab941d01aeb4b12e6a3fc017807b4b8 Merge lane/hm37-integ (32324db5): HM37 window A close transfer fix and close-resume section
6b549ef61eea6f8cc2afd7dad69dcbe8b8ecaa0f Merge lane/hm37-integ (206f3084): HM37 CATALOG_04 proof fix, self-naming checks, rollback constraint kinds
00837a48b1af93ea7cef8b063a9e23dae4ea8c00 Merge lane/hm37-integ (e8908362): HM37 plans fixed against a full read-only live audit (56 mismatches)
f0382efc40f8900eda5ebc35151ec699954cde5d fix(test): portable temp dir in the H0 flag guard; allowlist the squash-merge identity
47c27b9e23153be434f52371cbe442efe5c59d37 Merge lane/hm37-integ (76da7452): HM37 plan fixes found on the live box (edge has no deno; pre-04 token columns)
0fc7032e8ea59a5ce9c55f3e764a5cd6475f83e9 Merge lane P4: tasks and calendar spec (design doc)
b8c2c747a8a26ae8906ab97bc8ad20d5c94dd8e9 Merge lane P3: files and wiki design (design doc)
b2692e8b6ce54eca25cd055c03c7d1c2fe0903b1 Merge lane B0: delegated admin spec amendment (design doc)
0229f5a7bc2f9e9891164893348e1d459776d855 Merge lane P2: household privacy boundaries (design doc)
fef9cbeb39b014e710d765e863c4d144089343ef Merge lane P1: agent onboarding matrix (design doc)
ed14a742cfd0d19b7e6e2200f0d405c1f54a225e Merge lane A: agent-admin grant contract (design doc)
b8e75d7bd1292176faf495c494ded00a204b7e43 Merge lane/hm37-integ (9c09cc4f): HM37 release plans, harness and lane 8 re-pin
4d6a06509f9abf1aefac8c88ec00280d025df673 Merge fix/site-reference-after-overhaul (#32): parity reference and H0 flag guard after the brand overhaul
e5eafd0ed88575344262644897d7909f720d3e39 Merge design/brand-daylight-orbs: Daylight Orbs brand overhaul (live 109e4db7)
1e68e4853564b3cf796587801699ec63a550eae5 Merge fix/site-parity-reference-prefix (#30): parity check uses the asset prefix once
77bac401f65516679aea4332ac20f8eda2c8591e Merge release/site-homepage (3fbd5b76, live homepage) into main
fdce0cba29c95142f4b1d5bef4b1cec01dfa27be feat(site): homepage redesign — every agent, one common thread (#29)
beb93996166af94b60d08b5cb2433956cba28f28 fix(release): HM37 plan and runbook pass a whole-block dry run on measured box facts
48c2a28d73c23227fa69bb0916b6f28c1c5d5be8 docs(evidence): add second box-facts measurement
15561bf82c87e3066e38a2bb99dab2c07d48cc90 docs(evidence): measure production box facts
c067b729fb9d2d997e292dca1445ef4725330912 docs(evidence): record HM37 window 021020 abort
d24609aa3cee0960e665509e17dbe407ee6df006 fix(release): a rolled-back window leaves state the next window accepts
b912b349a1f732ed71962bdf0a6a3ba84d0c1805 fix(evidence): HM37 plan revision after window 4, with readonly markers, a commit point and box-reality tests
229cc29ebc248652cc76d899515217ae8d51ed18 docs(evidence): record rolled-back HM37 box window
09efbb1f1ba0998f7abbafcfd9c5c369f5dc1fd9 docs(evidence): Sonnet 5.5 Maker baseline results
65700e6b117149f7744aa64567bbe5e91cbef24a test(cli): update timeout citations and inventory for the /proc stdout scanner
199dc02f77554a4e2b79c06f4aa270bc283f8b89 fix(cli): a permission error in the /proc scan means "cannot determine", never "reader gone"
a730af1e85d6c368fcf409568b3880e741552034 feat(cli): detect the stdout reader on Linux through /proc
1b1a5549717f6a1b902dc1f88ab927b894245506 fix(evidence): HM37 plan accepts the JWKS media type, and a test replays live lane 6 responses
2c71c5d377584ea56996c182c1d7e84f5fcc0dfb docs(evidence): record the live lane 6 responses that the HM37 plan probes
c4d32d9e372188735f4b89e0f5a3be4c73355abf test(files): one gate checks that every 25 MiB file limit agrees
fd9dc36c87ce7cf714bf5d6615792a9348dd316f fix(rebrand): active references use the yulanventures GitHub organization
c9c5eae39f5efaa0b95ed36c4310c08bfe3a9c8c docs(evidence): record successful HM6 OAuth window
7e87bceb20e902f9a80f64d1de297c9d0fa9c3b0 fix(release-proofs): HM37 harness sends the provider-artifact payload as one JSON object
ee02e571f653fd070ee9c27e3bf5e32d34ef1e4d fix(release-proofs): HM37 provider-artifact fixture matches the production adapter
cddd6b3a299859b9e695d315c78e09939bacda50 Merge main into lane/hm37-open-ack-harness for the server-repeat guard
cad85a346e488895e917d1cdd7258ce236d6663c fix(release-proofs): HM37 harness reports its failing step, and uses the proven capability transaction
e8b68beacaae5dccada3176aa16ed610a5f428bc feat(release-proofs): HM lanes 3+7 hosted open/ACK control harness, and the plan's section 9 names it
3f12f6513fd6b08716b652ce9cc26599539b63e8 docs(evidence): HM lane 6 box plan v5 to finish the rollout from the rolled-back v4 state
3246ff63d07c0777d6431322909feb8b872fed33 docs(evidence): HM lanes 3 and 7 dark plan v4 at release eb2a87ac, with HM6's two-part precondition
```

## Compatibility and privilege contract

| Migration | Edge 65a6caf0 against new schema | Reserve rollback impact |
| --- | --- | --- |
| 01 | Compatible: only new private tables; old edge never addresses them before admin activation. | Drops all new account/grant/credential/audit history; refuse nonempty admin tables. |
| 02 | Compatible for existing workers: new fields nullable, existing rows have NULL parent; parent helpers return true for NULL. Old edge writes explicit columns; the event CHECK activates only for non-NULL grant. Trigger renewal preserves NULL ancestry. | Removes ancestry and routine tables; routine projection backfill is not undone by the reserve. Refuse admin data and non-NULL ancestry; no CASCADE. |
| 03 | Compatible: new function, no existing signature replaced or private-table grants. | Drops only recovery function; rollback 03 before dropping its underlying tables. |
| 04 | Compatible: same function OID/input/TABLE return, VOLATILE definer and read privilege; NULL-parent workers pass. No old query adopts admin rights. | Restores verbatim pre-admin body and STABLE scopes helper; run before 02. |
| 05 | Compatible: new command-only function; obsolete view absent in the known migration chain. | Drops new function, does not recreate a pre-existing obsolete view; preflight requires that view absent. Run before 02. |

A failed edge step after committed migrations can safely leave **all five
migrations applied with edge 65a6caf0 restored and MCP ON** while no new admin
operations have committed. The preflight proves the starting private catalog
absent. This is a schema compatibility claim, not a rollback guarantee after
admin use: baseline workspace-reducer.ts rejects unknown event types; new
Admin* workspace history may break old-edge replay. Keep admin activation out
of this release window. If admin operations occur during the new-edge interval,
report that rollback compatibility is NOT PROVED and have HezLead direct recovery. Prefer this additive state and a
reviewed forward edge repair. Do not run SQL rollback reflexively. New edge
must never run against a rolled-back schema; edge rollback and ON verification
come first. SQL rollback requires `SCHEMA_ROLLBACK_APPROVAL=yes`, the exact
next applied version in reverse order, old edge container identity and health,
and zero admin data/ancestry. It destroys account history; after actual admin
use, stop and request a reviewed recovery plan. Neither reserve restores
external actions nor a database snapshot. Backfill remnants mean data-byte
identity is not claimed; rollback proofs assert catalog preconditions only.

No migration requests CREATE ROLE/extension, pg_cron scheduling, publication,
BYPASSRLS, superuser-only trigger operations or host grants. Minimum rights:
CREATE/USAGE on swarm and swarm_read as relevant; SET ROLE/ownership membership
for swarm_admin to ALTER OWNER; ownership of events/agent_principals/agent_tokens
and agent_delivery_read_context for 02/04; REFERENCES on users/workspaces/grants,
EXECUTE of append-only trigger and relevant schemas; read/update admin_accounts
for 02 backfill; ledger INSERT/DELETE and proof catalog access. No runtime role
is widened beyond grants inside the migrations. The **existing release helper's
target identity contract explicitly requires current_user=supabase_admin with
rolsuper** (migrate/lib.sh). This procedure retains that contract and verifies it
before applying, so no additional privilege escalation is requested. A later
least-privilege migration login would need a separately reviewed role procedure;
this plan must not silently SET ROLE or grant itself missing rights.

Proofs in deploy/release-proofs/item-cd: forward catalogs validate columns,
constraints, ownership/RLS/policies/ACLs, index validity and trigger/function
identities. Function checks include exact signatures, return contracts, owner,
security, search path, volatility and individual privileges. Stored body MD5
fingerprints also distinguish 04's fenced and restored implementations (same
identity and return type); they are not deparsed-function substring matches.
02 permits STABLE or VOLATILE on scopes so its proof remains true after 04;
04 itself requires VOLATILE. Rollbacks are byte-for-byte copies of the five
supabase/admin-delegation-reserve files. Rollback proofs restore catalog state;
01/02 catalog checks also refuse missing dependencies. Offline format/shell
checks do **not** prove PostgreSQL parsing or execution. No live DB, Docker,
SSH, browser, or authenticated admin smoke was run in preparation. The generic
format test recursively discovers all 10 new catalog files; no new inventory
list is needed. Its two stale runbook fixture markers were updated to the
current KIND_ARRAY loop and %q state output; the real immutable-directory
positive/negative controls then pass. The G3-specific server test enumerates
only G3 migrations and needs Docker; it is not a C+D offline gate and is NOT RUN.

## Inputs and step order

| Input | Format / source | Use |
| --- | --- | --- |
| RELEASE_SHA | 40 lowercase hex, merge of this lane on origin/main, HezLead supplied | Archive final reviewed code plus plan/proofs. Must differ from baseline. |
| BASELINE_EDGE_SHA | 65a6caf0f03066d60a18591fca3a370ecc59744d | Passed as validated input to generalized edge plan. |
| CD_PLAN_FILE | Absolute path to this plan from the exact release tree | Schema marked block extraction. |
| EDGE_PLAN_FILE | Absolute path to generalized 2026-10-02-edge-mcp-release/RELEASE.md from same tree | Edge marked block extraction. |
| GATE_EVIDENCE_FILE | Exact RELEASE_SHA evidence supplied by lead, regular nonsecret file | SHA, command-core, read build, check:edge, proof format and shell gates PASS. |
| BACKUP_MAX_AGE_SECONDS | Positive decimal, agreed by HezLead | Fresh verified complete database/object R2 backup before first apply. |
| MIGRATION_WINDOW_END_UTC | Valid UTC timestamp, future ≤6 hours at stage | Schema window bound, including backup wait. |
| WINDOW_END_UTC | Future UTC timestamp ≤30 minutes at edge preflight | A fresh short edge window after schema verification. |
| MAX_MCP_OUTAGE_SECONDS | **240** for this C+D handoff | Explicit edge input; no hard-coded budget change in reusable plan. |
| CD_ARCHIVE_DIR, CD_WINDOW_ID, CD_BOX_ARCHIVE_PATH, CD_ARCHIVE_SHA256 | Derived by cd-archive; fresh directory and six alphanumerics; archive digest | Schema transport/staging. Retain original values for cleanup. |
| CD_BOX_STEP | One schema step below | cd-transport allowlist. |
| ROLLBACK_VERSION | One of 05..01, only for reserve | Strict next applied version; derived applied prefix prevents skips. |
| SCHEMA_ROLLBACK_APPROVAL | yes, only on HezLead instruction | Destructive reserve approval, never inferred. |
| SECRET_STAGE | Only for cd-open-abort after failed session: exact reported mktemp directory | Nonsecret path input, never guessed from glob. |
| PLAN_FILE, BOX_STEP, ARCHIVE_DIR, WINDOW_ID, BOX_ARCHIVE_PATH, EDGE_ARCHIVE_SHA256 | Produced/set by cd-edge-inputs then edge-mcp-archive | Existing edge plan's transport and cleanup state, separate from schema state. |

Normal order (run all, stop on first FAIL):
1. `cd-archive`, then `cd-stage`, `cd-session`, `cd-preflight`, `cd-backup-gate`,
   `cd-apply-01`, `cd-apply-02`, `cd-apply-03`, `cd-apply-04`, `cd-apply-05`,
   `cd-schema-verify`. Use `cd-transport` to execute each schema box step.
2. `cd-edge-inputs`, then generalized plan `edge-mcp-archive`,
   `edge-mcp-preflight` + `edge-mcp-open` together via `edge-mcp-transport`,
   `edge-mcp-stage`, `edge-mcp-transition-503`, `edge-mcp-apply`,
   `edge-mcp-restore-on`, `edge-mcp-probes`. **Migrations commit before edge.**
3. `cd-admin-smoke`, `edge-mcp-close`, `edge-mcp-mac-close`,
   `cd-schema-close`, `cd-mac-close`. Keep schema session for final readback
   until edge/admin probes are recorded. No file containing secrets is copied back.

Before schema write, a FAIL closes with cd-schema-close/cd-mac-close after
recording state. If cd-stage failed before state was created, use
cd-stage-abort followed by cd-mac-close; incomplete proof staging is retained
under its exact per-window name for diagnosis, never repaired in place. A failed apply transaction rolls back its own ledger+DDL;
retain earlier successful migrations. Do not auto-retry a failed step. Resume
only on HezLead instruction in the **same open window**; apply blocks skip a
previously applied version only with ledger=1/catalog=t and a contiguous known
prefix. A new window requires a new archive ID; preflight normally demands all
five absent, so partial-prefix recovery requires a separately authorized resume
rather than treating the normal preflight as success. Closed windows never reopen.

After edge transition failure use the generalized edge rollback/probes/close/
Mac close sequence and timer recovery/failed-open cleanup exactly as documented.
Then retain schema or, only if approved, run `cd-schema-rollback` for 05→01
(or the highest committed prefix downward), then `cd-schema-close`, `cd-mac-close`.
SQL rollback never opens the MCP 503 boundary and never changes OAuth.
All cleanup blocks remain available beyond the forward window end.

## Marked schema window

```sh
# step: cd-archive
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-archive: line $LINENO; STOP before window" >&2' ERR
: "${RELEASE_SHA:?}" "${CD_PLAN_FILE:?}" "${EDGE_PLAN_FILE:?}" "${GATE_EVIDENCE_FILE:?}"
case "$RELEASE_SHA" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#RELEASE_SHA}" = 40
test "$RELEASE_SHA" != 65a6caf0f03066d60a18591fca3a370ecc59744d
test -z "$(git status --porcelain)"
git remote get-url origin | python3 -c 'import sys; assert sys.stdin.read().strip() in ("https://github.com/yulanventures/commonswarm.git","git@github.com:yulanventures/commonswarm.git")'
git fetch origin main
test "$(git rev-parse "${RELEASE_SHA}^{commit}")" = "$RELEASE_SHA"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
git merge-base --is-ancestor e81c77a4bd80a1f551a3cc1c32216e128a96a7cb "$RELEASE_SHA"
git diff --quiet e81c77a4bd80a1f551a3cc1c32216e128a96a7cb "$RELEASE_SHA" -- supabase/functions supabase/migrations deploy/edge-runtime deploy/supabase-stack
python3 - "$CD_PLAN_FILE" "$EDGE_PLAN_FILE" "$GATE_EVIDENCE_FILE" "$RELEASE_SHA" <<'PYCODE'
import pathlib,subprocess,sys
for value,relative in zip(sys.argv[1:3],['docs/evidence/2026-10-02-cd-release/RELEASE.md','docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md']):
 p=pathlib.Path(value); assert p.is_absolute() and not p.is_symlink() and p.is_file()
 assert p.read_bytes()==subprocess.check_output(['git','show',sys.argv[4]+':'+relative])
p=pathlib.Path(sys.argv[3]); assert p.is_file() and not p.is_symlink()
lines=p.read_text().splitlines(); assert 'SHA='+sys.argv[4] in lines
for gate in ['npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js',
 'node supabase/functions/read/build-admin-recovery.mjs && git diff --exit-code supabase/functions/read/admin-recovery-contract.ts',
 'npm run check:edge','node --import tsx --test tests/release-proof-format.test.ts','both release plans /bin/bash -n']:
 assert gate+': PASS' in lines, 'FAIL cd-archive: missing exact-SHA gate evidence'
PYCODE
CD_ARCHIVE_DIR=$(mktemp -d /private/tmp/cd-release-archive.XXXXXX)
chmod 0700 "$CD_ARCHIVE_DIR"
CD_WINDOW_ID=${CD_ARCHIVE_DIR##*.}
git archive --format=tar --output "$CD_ARCHIVE_DIR/release.tar" "$RELEASE_SHA"
test "$(git get-tar-commit-id <"$CD_ARCHIVE_DIR/release.tar")" = "$RELEASE_SHA"
chmod 0600 "$CD_ARCHIVE_DIR/release.tar"
CD_ARCHIVE_SHA256=$(shasum -a 256 "$CD_ARCHIVE_DIR/release.tar" | awk '{print $1}')
CD_BOX_ARCHIVE_PATH=/tmp/cd-release-${RELEASE_SHA}-${CD_WINDOW_ID}.tar
printf -v REMOTE_COMMAND 'test "$(stat -c %%a /tmp)" = 1777 && (set -C; umask 077; : > %q)' "$CD_BOX_ARCHIVE_PATH"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
scp -p "$CD_ARCHIVE_DIR/release.tar" "ops@100.115.66.74:$CD_BOX_ARCHIVE_PATH"
printf 'CD_WINDOW_ID=%s\nCD_BOX_ARCHIVE_PATH=%s\nCD_ARCHIVE_SHA256=%s\n' "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256"
```

```sh
# step: cd-transport
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-transport: line $LINENO; STOP" >&2' ERR
: "${CD_PLAN_FILE:?}" "${CD_BOX_STEP:?}" "${RELEASE_SHA:?}" "${CD_WINDOW_ID:?}" "${CD_ARCHIVE_DIR:?}"
python3 - "$CD_ARCHIVE_DIR" "$CD_WINDOW_ID" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); assert re.fullmatch(r'/private/tmp/cd-release-archive\.[A-Za-z0-9]{6}',str(p))
assert str(p).rsplit('.',1)[1]==sys.argv[2] and not p.is_symlink() and p.resolve(strict=True)==p
assert p.is_dir() and p.stat().st_mode & 0o777==0o700
PYCODE
case "$CD_BOX_STEP" in
 cd-stage|cd-session|cd-preflight|cd-backup-gate|cd-apply-01|cd-apply-02|cd-apply-03|cd-apply-04|cd-apply-05|cd-schema-verify|cd-admin-smoke|cd-schema-rollback|cd-schema-close|cd-open-abort|cd-stage-abort) ;;
 *) echo 'FAIL cd-transport: unknown step; STOP' >&2; exit 1;;
esac
python3 - "$CD_PLAN_FILE" "$CD_BOX_STEP" >"$CD_ARCHIVE_DIR/box-step.sh" <<'PYCODE'
import pathlib,re,sys
blocks=re.findall(r'^```sh\n(.*?)^```$',pathlib.Path(sys.argv[1]).read_text(),re.M|re.S)
found=[b for b in blocks if b.splitlines()[0]=='# step: '+sys.argv[2]]
assert len(found)==1, 'FAIL cd-transport: duplicate/missing step'
print(found[0])
PYCODE
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -s -- %q %q %q %q %q %q %q %q %q' \
 "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" \
 "$BACKUP_MAX_AGE_SECONDS" "$MIGRATION_WINDOW_END_UTC" "${SCHEMA_ROLLBACK_APPROVAL:-no}" "${ROLLBACK_VERSION:-}" "${SECRET_STAGE:-}"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND" <"$CD_ARCHIVE_DIR/box-step.sh"
```

```sh
# step: cd-stage
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-stage: line $LINENO; no schema/service change; STOP" >&2' ERR
RELEASE_SHA=${1:?}; CD_WINDOW_ID=${2:?}; CD_BOX_ARCHIVE_PATH=${3:?}; CD_ARCHIVE_SHA256=${4:?}
BACKUP_MAX_AGE_SECONDS=${5:?}; MIGRATION_WINDOW_END_UTC=${6:?}
test "$(id -u)" = 0
python3 - "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" "$BACKUP_MAX_AGE_SECONDS" "$MIGRATION_WINDOW_END_UTC" <<'PYCODE'
import datetime,pathlib,re,sys
s,w,a,h,age,end=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and s!='65a6caf0f03066d60a18591fca3a370ecc59744d'
assert re.fullmatch('[A-Za-z0-9]{6}',w) and a==f'/tmp/cd-release-{s}-{w}.tar'
assert re.fullmatch('[0-9a-f]{64}',h) and re.fullmatch('[1-9][0-9]*',age)
assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',end)
until=datetime.datetime.strptime(end,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
assert 0<(until-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<=21600
p=pathlib.Path(a); assert not p.is_symlink() and p.is_file() and p.stat().st_mode & 0o777==0o600
PYCODE
test "$(sha256sum "$CD_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$CD_ARCHIVE_SHA256"
BASELINE_EDGE_SHA=65a6caf0f03066d60a18591fca3a370ecc59744d
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA"
PROOF_DIR=/home/commonswarm/stack/release-proofs/${RELEASE_SHA}-${CD_WINDOW_ID}
NEW_STACK=/home/commonswarm/stack/releases/$RELEASE_SHA
STACK_RELEASE=$NEW_STACK
# Immutable archive staging only: stack/current and every service stay unchanged.
test ! -e "$PROOF_DIR" && test ! -L "$PROOF_DIR"
install -d -m 0700 -o root -g root "$PROOF_DIR"
python3 - "$CD_BOX_ARCHIVE_PATH" "$PROOF_DIR" "$NEW_STACK" "$RELEASE_SHA" <<'PYCODE'
import hashlib,os,pathlib,pwd,shutil,stat,sys,tarfile
archive,proof,new,sha=sys.argv[1:]; proof=pathlib.Path(proof); source=proof/'source'; new=pathlib.Path(new)
source.mkdir(mode=0o700)
with tarfile.open(archive) as tar:
 names=set()
 for m in tar.getmembers():
  p=pathlib.PurePosixPath(m.name)
  assert not p.is_absolute() and '..' not in p.parts and m.name not in names and m.name!='RELEASE_SHA'
  names.add(m.name); assert m.isfile() or m.isdir() or m.issym()
  if m.issym():
   target=pathlib.PurePosixPath(m.linkname); assert not target.is_absolute() and '..' not in target.parts
 tar.extractall(source,filter='data')
(source/'RELEASE_SHA').write_text(sha+'\n')
def entries(root):
 result={}
 for parent,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   p=pathlib.Path(parent)/name; st=p.lstat(); kind=stat.S_IFMT(st.st_mode)
   assert kind in (stat.S_IFREG,stat.S_IFDIR,stat.S_IFLNK)
   if p.is_symlink(): assert p.resolve(strict=True).is_relative_to(root.resolve())
   value=os.readlink(p) if p.is_symlink() else p.read_bytes() if p.is_file() else None
   result[str(p.relative_to(root))]=(kind,stat.S_IMODE(st.st_mode),value)
 return result
expected=entries(source); uid=pwd.getpwnam('commonswarm').pw_uid; gid=pwd.getpwnam('commonswarm').pw_gid
if not new.exists() and not new.is_symlink():
 shutil.copytree(source,new,symlinks=True); os.chmod(new,0o755); os.chown(new,uid,gid)
 for parent,dirs,files in os.walk(new,followlinks=False):
  for name in dirs+files: os.chown(pathlib.Path(parent)/name,uid,gid,follow_symlinks=False)
assert not new.is_symlink() and new.resolve(strict=True)==new and new.stat().st_mode & 0o777==0o755
assert entries(new)==expected, 'FAIL cd-stage: existing immutable stack directory differs; STOP'
assert (new.stat().st_uid,new.stat().st_gid)==(uid,gid)
for parent,dirs,files in os.walk(new,followlinks=False):
 for name in dirs+files:
  st=(pathlib.Path(parent)/name).lstat(); assert (st.st_uid,st.st_gid)==(uid,gid)
for version in ['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005']:
 for suffix in ['catalog.sql','rollback.sql','rollback-catalog.sql']:
  p=source/'deploy/release-proofs/item-cd'/f'{version}-{suffix}'
  assert p.is_file() and not p.is_symlink()
  if suffix=='rollback.sql': assert p.read_bytes()==(source/'supabase/admin-delegation-reserve'/p.name).read_bytes()
  shutil.copyfile(p,proof/p.name); os.chmod(proof/p.name,0o600)
(proof/'proof-inputs.sha256').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(proof.glob('*.sql'))))
print('PASS cd-stage: exact archive and all 15 reviewed proofs; stack/current unchanged')
PYCODE
# Persist paths only; never persist credential contents in proof state.
{
 for name in RELEASE_SHA CD_WINDOW_ID CD_BOX_ARCHIVE_PATH CD_ARCHIVE_SHA256 BACKUP_MAX_AGE_SECONDS MIGRATION_WINDOW_END_UTC BASELINE_EDGE_SHA PROOF_DIR NEW_STACK STACK_RELEASE; do printf '%s=%q\n' "$name" "${!name}"; done
} >"$PROOF_DIR/state.sh"
chmod 0600 "$PROOF_DIR/state.sh"
```

```sh
# step: cd-session
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'printf "FAIL cd-session: line %s; no schema/service change; cd-open-abort SECRET_STAGE=%s\n" "$LINENO" "${SECRET_STAGE:-not-created}" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt" && test ! -e "$PROOF_DIR/session-ready.txt"
umask 077
test -d /private/tmp && test ! -L /private/tmp
SECRET_STAGE=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SECRET_STAGE"
# Persist the exact cleanup path immediately, including failures before helper creation.
printf 'SECRET_STAGE=%q\n' "$SECRET_STAGE" >>"$PROOF_DIR/state.sh"
MIGRATE=$STACK_RELEASE/deploy/supabase-stack/migrate
PGSERVICE_FILE=$SECRET_STAGE/service.conf
PGPASS_FILE=$SECRET_STAGE/pass
APPLY_SQL=$PROOF_DIR/apply.sql
DB_SESSION=$SECRET_STAGE/session.sh
PSQL_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.147
PSQL_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$PSQL_IMAGE")
POSTGRES_CIDS=()
while IFS= read -r value; do test -z "$value" || POSTGRES_CIDS[${#POSTGRES_CIDS[@]}]=$value; done < <(docker ps -q --filter label=com.docker.compose.project=commonswarm-supabase-stack --filter label=com.docker.compose.service=postgres)
test "${#POSTGRES_CIDS[@]}" = 1
test "$(docker inspect --format '{{.Image}}' "${POSTGRES_CIDS[0]}")" = "$PSQL_IMAGE_ID"
for path in /home/commonswarm/.env /etc/commonswarm-release/target.env; do
 test -f "$path" && test ! -L "$path" && test "$(stat -c %a "$path")" = 600
done
unset SOURCE_DATABASE_URL TARGET_DATABASE_URL
# make-pg-service reads the existing files; credentials never enter shell variables/argv.
PG_SERVICE_OUTPUT="$PGSERVICE_FILE" PG_PASS_OUTPUT="$PGPASS_FILE" \
 COMMONSWARM_ENV_FILE=/home/commonswarm/.env COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
 node "$MIGRATE/make-pg-service.mjs" >/dev/null 2>&1
chmod 0600 "$PGSERVICE_FILE" "$PGPASS_FILE"
install -m 0600 /dev/null "$APPLY_SQL"
{
 for name in MIGRATE PGSERVICE_FILE PGPASS_FILE APPLY_SQL DB_SESSION PSQL_IMAGE; do printf '%s=%q\n' "$name" "${!name}"; done
} >>"$PROOF_DIR/state.sh"
cat >"$DB_SESSION" <<'HELPERS'
release_psql() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$APPLY_SQL") CONTAINER_FILE=/run/commonswarm-release-apply.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql: --file must name APPLY_SQL or a PROOF_DIR file' >&2; return 2 ;;
        esac
        PSQL_ARGS[${#PSQL_ARGS[@]}]=--file
        PSQL_ARGS[${#PSQL_ARGS[@]}]="$CONTAINER_FILE"
        shift 2
        ;;
      -f|-f?*|--file=*) printf '%s\n' 'release_psql: use separate --file and host path arguments' >&2; return 2 ;;
      *) PSQL_ARGS[${#PSQL_ARGS[@]}]="$1"; shift ;;
    esac
  done
  docker run --rm \
    --network commonswarm-net \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --env PGSERVICE=target \
    --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
    --env PGPASSFILE=/run/commonswarm-pg-pass \
    --volume "$PGSERVICE_FILE:/run/commonswarm-pg-service.conf:ro" \
    --volume "$PGPASS_FILE:/run/commonswarm-pg-pass:ro" \
    --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
    --volume "$STACK_RELEASE/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$APPLY_SQL:/run/commonswarm-release-apply.sql:ro" \
    --entrypoint psql \
    "$PSQL_IMAGE" \
    -X --set=ON_ERROR_STOP=1 "${PSQL_ARGS[@]}"
}

release_psql_ro() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$APPLY_SQL") CONTAINER_FILE=/run/commonswarm-release-apply.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql_ro: --file must name APPLY_SQL or a PROOF_DIR file' >&2; return 2 ;;
        esac
        PSQL_ARGS[${#PSQL_ARGS[@]}]=--file
        PSQL_ARGS[${#PSQL_ARGS[@]}]="$CONTAINER_FILE"
        shift 2
        ;;
      -f|-f?*|--file=*) printf '%s\n' 'release_psql_ro: use separate --file and host path arguments' >&2; return 2 ;;
      *) PSQL_ARGS[${#PSQL_ARGS[@]}]="$1"; shift ;;
    esac
  done
  docker run --rm \
    --network commonswarm-net \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --env PGSERVICE=target \
    --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
    --env PGPASSFILE=/run/commonswarm-pg-pass \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    --volume "$PGSERVICE_FILE:/run/commonswarm-pg-service.conf:ro" \
    --volume "$PGPASS_FILE:/run/commonswarm-pg-pass:ro" \
    --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
    --volume "$STACK_RELEASE/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$APPLY_SQL:/run/commonswarm-release-apply.sql:ro" \
    --entrypoint psql \
    "$PSQL_IMAGE" \
    -X --set=ON_ERROR_STOP=1 "${PSQL_ARGS[@]}"
}
HELPERS
chmod 0600 "$DB_SESSION"
. "$DB_SESSION"
# Reuse the repository's literal target identity SQL without running run-db-tool,
# which stages connection files outside the task's protected secret directory.
python3 - "$MIGRATE/lib.sh" "$PROOF_DIR/identity.sql" <<'PYCODE'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
part=source.split('assert_target_identity() {\n',1)[1].split('\nassert_backup_ro_identity()',1)[0]
sql=part.split("<<'SQL'\n",1)[1].split('\nSQL',1)[0]
assert "current_user <> 'supabase_admin'" in sql and 'rolsuper' in sql
pathlib.Path(sys.argv[2]).write_text(sql+'\n')
PYCODE
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
printf 'ready\n' >"$PROOF_DIR/session-ready.txt"
printf 'PASS cd-session: target-only standard release psql/ro helpers; secret values withheld\n'
```

```sh
# step: cd-preflight
# readonly: yes (database/services; writes nonsecret evidence)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-preflight: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA"
python3 - "$BASELINE_EDGE_SHA" <<'PYCODE'
import pathlib,json,subprocess,sys
edge=json.loads(subprocess.check_output(['docker','inspect','commonswarm-edge-edge-runtime-1'],stderr=subprocess.DEVNULL))[0]
assert edge['State']['Health']['Status']=='healthy'
assert edge['Config']['Labels']['com.docker.compose.project.working_dir']==f'/home/commonswarm/edge/releases/{sys.argv[1]}/deploy/edge-runtime'
live=dict(v.split('=',1) for v in edge['Config']['Env']); names=[]
for line in pathlib.Path('/home/commonswarm/.env').read_text().splitlines():
 if line.strip() and not line.lstrip().startswith('#'): names.append(line.split('=',1)[0].strip())
assert len(names)==len(set(names))
assert ('SWARM_ENV' in live)==('SWARM_ENV' in names)
assert 'SWARM_ENV' not in live or live['SWARM_ENV']=='production'
assert not any(k.startswith('SWARM_CMD_TEST_') for k in set(live)|set(names))
assert live.get('SWARM_MCP_PUBLIC_ENABLED')=='1' and live.get('SWARM_SELF_SERVE')=='1'
print('PASS cd-preflight: SWARM_ENV presence='+('set' if 'SWARM_ENV' in live else 'absent')+'; values withheld; MCP ON')
PYCODE
# Standard release helper, full file/ledger reconciliation, not a version-only guess.
release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/applied-before.txt"
python3 - "$STACK_RELEASE/supabase/migrations" "$PROOF_DIR" <<'PYCODE'
import pathlib,re,sys
m=pathlib.Path(sys.argv[1]); p=pathlib.Path(sys.argv[2]); files=sorted(m.glob('*.sql'))
versions=[f.name.split('_',1)[0] for f in files]; assert all(re.fullmatch('[0-9]{14}',v) for v in versions)
assert len(versions)==len(set(versions))
applied=(p/'applied-before.txt').read_text().splitlines()
assert len(applied)==len(set(applied)) and set(applied)<=set(versions)
pending=[v for v in versions if v not in applied]
assert pending==['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005'], 'FAIL cd-preflight: expected exactly five absent admin versions; STOP'
assert applied and max(applied)<min(pending), 'FAIL cd-preflight: unexplained older gap; STOP'
(p/'migration-files.txt').write_text(''.join(str(f)+'\n' for f in files))
(p/'expected-pending.txt').write_text('\n'.join(pending)+'\n')
PYCODE
# All future object lookups are error-safe; prove the complete 01 pre-catalog.
printf '\\i /proof/20261001000001-rollback-catalog.sql\nSELECT :\x27rollback_ok\x27::boolean;\n' >"$APPLY_SQL"
test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
release_psql_ro -Atq --command "SELECT to_regclass('swarm.admin_routine_workspace_events') IS NULL AND to_regprocedure('swarm_read.admin_recovery_page(text,uuid,integer,text)') IS NULL AND to_regprocedure('swarm.admin_routine_workspace_history(uuid,uuid,uuid)') IS NULL;" >"$PROOF_DIR/absent-future.txt"
test "$(cat "$PROOF_DIR/absent-future.txt")" = t
release_psql_ro -Atq --command "SELECT NOT EXISTS (SELECT 1 FROM pg_attribute WHERE NOT attisdropped AND ((attrelid=to_regclass('swarm.events') AND attname IN ('admin_identity_id','grant_id','grant_manifest_digest')) OR (attrelid=to_regclass('swarm.agent_principals') AND attname='parent_admin_grant_id') OR (attrelid=to_regclass('swarm.agent_tokens') AND attname IN ('parent_admin_grant_id','recipient_connection_id')))) AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('swarm.agent_tokens') AND polname='admin_parent_select') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.events') AND conname='delegated_event_actor');" >"$PROOF_DIR/absent-ancestry.txt"
test "$(cat "$PROOF_DIR/absent-ancestry.txt")" = t
# Ledger supports version-only inserts; no role or privilege changes are performed.
release_psql_ro -Atq --command "SELECT current_user='supabase_admin' AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AND has_schema_privilege(current_user,'swarm','CREATE') AND has_schema_privilege(current_user,'swarm_read','CREATE') AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','INSERT') AND has_table_privilege(current_user,'supabase_migrations.schema_migrations','DELETE') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='supabase_migrations' AND table_name='schema_migrations' AND column_name <> 'version' AND is_nullable='NO' AND column_default IS NULL);" >"$PROOF_DIR/privilege-preflight.txt"
test "$(cat "$PROOF_DIR/privilege-preflight.txt")" = t
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-before.txt"
release_psql_ro -Atq --command "SELECT md5(prosrc)='7bdac2f2c2473a7229c893c7ab9ce008' AND prosecdef AND provolatile='v' AND proretset AND prorettype='record'::regtype FROM pg_proc WHERE oid=to_regprocedure('swarm.agent_delivery_read_context(bytea,uuid)');" >"$PROOF_DIR/old-read-fence.txt"
test "$(cat "$PROOF_DIR/old-read-fence.txt")" = t
touch "$PROOF_DIR/preflight.txt"
printf 'PASS cd-preflight: exact five pending versions, private catalog absent, target/role/ledger verified\n'
```

```sh
# step: cd-backup-gate
# readonly: yes (database/services; writes nonsecret evidence)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-backup-gate: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

test -f "$PROOF_DIR/preflight.txt"
  DEADLINE=$(( $(date +%s) + 14400 ))
  while :; do
    STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    case "$STATE" in
      inactive|failed) break ;;
      active|activating|deactivating|reloading)
        NOW="$(date +%s)"
        test "$NOW" -lt "$DEADLINE"
        WAIT_SECONDS=5
        if [ "$((DEADLINE - NOW))" -lt "$WAIT_SECONDS" ]; then
          WAIT_SECONDS=$((DEADLINE - NOW))
        fi
        sleep "$WAIT_SECONDS"
        ;;
      *) false ;;
    esac
  done
  test "$(systemctl show commonswarm-postgres-backup.service --property=Result --value)" = success
  python3 - /var/backups/commonswarm-postgres/status.json \
    "$BACKUP_MAX_AGE_SECONDS" >"$PROOF_DIR/backup-gate.txt" <<'PY'
import datetime, json, sys
data = json.load(open(sys.argv[1]))
assert data.get("ok") is True
assert data.get("database_bytes_verified") is True
assert data.get("object_bytes_verified") is True
verified = datetime.datetime.fromisoformat(data["verified_at"].replace("Z", "+00:00"))
age = (datetime.datetime.now(datetime.timezone.utc) - verified).total_seconds()
assert -300 <= age < int(sys.argv[2])
assert data.get("destination", "").startswith(
    "r2:yulan-vps-1-backups/000-commonswarm-postgres/")
print("backup_gate=PASS")
PY
test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
touch "$PROOF_DIR/backup-ready.txt"
```

```sh
# step: cd-apply-01
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-apply-01: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

# Save literal reviewed helper for later fresh root invocations.

cd_apply_one() {
 local VERSION=$1 LEDGER_COUNT CATALOG_BEFORE MIGRATION_FILE
 test -f "$PROOF_DIR/preflight.txt" && test -f "$PROOF_DIR/backup-ready.txt"
 # Repeat freshness every apply; a long backup wait cannot authorize stale later writes.
 python3 - /var/backups/commonswarm-postgres/status.json "$BACKUP_MAX_AGE_SECONDS" <<'PYCODE'
import datetime,json,sys
v=json.load(open(sys.argv[1])); assert all(v.get(k) is True for k in ('ok','database_bytes_verified','object_bytes_verified'))
age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(v['verified_at'].replace('Z','+00:00'))).total_seconds()
assert -300<=age<int(sys.argv[2]) and v.get('destination','').startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/')
PYCODE
 release_psql_ro -Atq --command "SELECT version FROM supabase_migrations.schema_migrations WHERE version >= '20261001000001' ORDER BY version;" >"$PROOF_DIR/applied-now.txt"
 python3 - "$PROOF_DIR/applied-now.txt" "$VERSION" <<'PYCODE'
import pathlib,sys
allv=['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005']
rows=pathlib.Path(sys.argv[1]).read_text().splitlines(); before=allv[:allv.index(sys.argv[2])]
assert len(rows)<=len(allv) and rows==allv[:len(rows)], 'FAIL cd-apply: migration prefix changed; STOP'
assert sys.argv[2] in rows or rows==before, 'FAIL cd-apply: prior migration not committed; STOP'
PYCODE
 MIGRATION_FILES=()
 while IFS= read -r value; do test -z "$value" || MIGRATION_FILES[${#MIGRATION_FILES[@]}]=$value; done < <(sed 's#.*/##' "$PROOF_DIR/migration-files.txt" | awk -v prefix="${VERSION}_" 'index($0,prefix)==1')
 test "${#MIGRATION_FILES[@]}" = 1
 MIGRATION_FILE=${MIGRATION_FILES[0]}
 case "$MIGRATION_FILE" in *[!a-z0-9_.]*) return 1;; esac
 LEDGER_COUNT=$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$VERSION';")
 printf '\\i /proof/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$APPLY_SQL"
 CATALOG_BEFORE=$(release_psql_ro -Atq --file "$APPLY_SQL")
 case "$LEDGER_COUNT:$CATALOG_BEFORE" in
  1:t) printf 'PASS cd-apply: %s already committed and catalog verified\n' "$VERSION"; return 0;;
  0:f) ;;
  *) echo 'FAIL cd-apply: unexpected ledger/catalog; STOP' >&2; return 1;;
 esac
 # Existing section-5 transaction procedure, one migration at a time.
 cat >"$APPLY_SQL" <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
DO \$ledger_shape\$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='supabase_migrations' AND table_name='schema_migrations' AND column_name='version')
 OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='supabase_migrations' AND table_name='schema_migrations' AND column_name <> 'version' AND is_nullable='NO' AND column_default IS NULL) THEN
  RAISE EXCEPTION 'schema_migrations cannot accept a version-only ledger row';
 END IF;
END \$ledger_shape\$;
\i /migrations/$MIGRATION_FILE
INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('$VERSION');
\i /proof/${VERSION}-catalog.sql
\if :{?catalog_ok}
SELECT :'catalog_ok'::boolean AS catalog_is_t
\gset
\if :catalog_is_t
\else
DO \$\$ BEGIN RAISE EXCEPTION 'C+D catalog failed for $VERSION'; END \$\$;
\endif
\else
DO \$\$ BEGIN RAISE EXCEPTION 'C+D catalog missing for $VERSION'; END \$\$;
\endif
COMMIT;
SQL
 release_psql_ro -q --file "$PROOF_DIR/identity.sql"
 # Silence SQL result values: statuses/counts are checked through readonly helper.
 release_psql -q --file "$APPLY_SQL"
 test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$VERSION';")" = 1
 printf '\\i /proof/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$APPLY_SQL"
 test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
 printf 'version=%s ledger=1 catalog=t\n' "$VERSION" >>"$PROOF_DIR/migration-applied.txt"
 printf 'PASS cd-apply: %s ledger=1 catalog=t\n' "$VERSION"
}

declare -f cd_apply_one >"$PROOF_DIR/apply-helper.sh"
chmod 0600 "$PROOF_DIR/apply-helper.sh"
cd_apply_one 20261001000001
```

```sh
# step: cd-apply-02
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-apply-02: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

. "$PROOF_DIR/apply-helper.sh"
cd_apply_one 20261001000002
```

```sh
# step: cd-apply-03
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-apply-03: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

. "$PROOF_DIR/apply-helper.sh"
cd_apply_one 20261001000003
```

```sh
# step: cd-apply-04
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-apply-04: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

. "$PROOF_DIR/apply-helper.sh"
cd_apply_one 20261001000004
```

```sh
# step: cd-apply-05
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-apply-05: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

. "$PROOF_DIR/apply-helper.sh"
cd_apply_one 20261001000005
```

```sh
# step: cd-schema-verify
# readonly: yes (database/services; writes nonsecret evidence)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-schema-verify: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test "$(date -u +%s)" -le "$(date -u -d "$MIGRATION_WINDOW_END_UTC" +%s)"
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
release_psql_ro -q --file "$PROOF_DIR/identity.sql"

for VERSION in 20261001000001 20261001000002 20261001000003 20261001000004 20261001000005; do
 test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$VERSION';")" = 1
 printf '\\i /proof/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$VERSION" >"$APPLY_SQL"
 test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
done
release_psql_ro -Atq --command "SELECT NOT EXISTS (SELECT 1 FROM swarm.admin_accounts WHERE NOT projection ? 'routine' OR jsonb_typeof(projection->'routine') IS DISTINCT FROM 'object');" >"$PROOF_DIR/routine-backfill.txt"
test "$(cat "$PROOF_DIR/routine-backfill.txt")" = t
release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/applied-after.txt"
LC_ALL=C sort "$PROOF_DIR/applied-before.txt" >"$PROOF_DIR/applied-before.sorted"
LC_ALL=C sort "$PROOF_DIR/applied-after.txt" >"$PROOF_DIR/applied-after.sorted"
LC_ALL=C comm -13 "$PROOF_DIR/applied-before.sorted" "$PROOF_DIR/applied-after.sorted" >"$PROOF_DIR/ledger-added.txt"
LC_ALL=C comm -23 "$PROOF_DIR/applied-before.sorted" "$PROOF_DIR/applied-after.sorted" >"$PROOF_DIR/ledger-removed.txt"
cmp -s "$PROOF_DIR/ledger-added.txt" "$PROOF_DIR/expected-pending.txt"
test ! -s "$PROOF_DIR/ledger-removed.txt"
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-after.txt"
cmp -s "$PROOF_DIR/cron-before.txt" "$PROOF_DIR/cron-after.txt"
touch "$PROOF_DIR/schema-verified.txt"
printf 'PASS cd-schema-verify: all five catalogs/ledger, backfill and zero cron changes; ready for edge\n'
```

## Edge window from the verified schema

The edge plan was generalized in a separate commit: baseline is a validated
40-hex prompt input in archive, preflight and rollback. Its ON baseline gates,
all-key digest comparisons, override carry, timer recovery, temporary Caddy 503
boundary, external OAuth/stack/site drift checks and bounded outage receipt are
retained. Use a fresh short WINDOW_END_UTC **after** schema/backup work. The
edge plan never alters schema, so the two proof/state directories stay separate.
Do not transplant HM37's DARK checks into this ON window.

```sh
# step: cd-edge-inputs
# readonly: yes
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-edge-inputs: line $LINENO; STOP" >&2' ERR
: "${RELEASE_SHA:?}" "${CD_WINDOW_ID:?}" "${EDGE_PLAN_FILE:?}" "${WINDOW_END_UTC:?}"
# Prove the exact schema receipt before any edge archive/window opens.
printf -v REMOTE_COMMAND 'sudo -n /bin/bash -c %q -- %q %q' \
 'set -euo pipefail; . "/home/commonswarm/stack/release-proofs/${1}-${2}/state.sh"; test ! -e "$PROOF_DIR/closed.txt"; test -f "$PROOF_DIR/schema-verified.txt"' "$RELEASE_SHA" "$CD_WINDOW_ID"
ssh -o BatchMode=yes -o ConnectTimeout=10 ops@100.115.66.74 "$REMOTE_COMMAND"
BASELINE_EDGE_SHA=65a6caf0f03066d60a18591fca3a370ecc59744d
MAX_MCP_OUTAGE_SECONDS=240
PLAN_FILE=$EDGE_PLAN_FILE
printf 'PASS cd-edge-inputs: RELEASE_SHA=%s BASELINE_EDGE_SHA=%s outage-budget=240s\n' "$RELEASE_SHA" "$BASELINE_EDGE_SHA"
```

Post-release: generalized edge-mcp-probes covers loopback health, public health,
anonymous MCP 401, resource metadata and authorization/openid discovery 200,
with ON/env/network/mount/override/external drift validation. These are boundary
probes, not authenticated MCP tools. cd-admin-smoke below checks the new read
handler's credential-class rejection with a public synthetic fixture, alongside
a health positive control. This contains no real bearer and changes no data.
An authenticated successful human recovery page or delegated command is
**NOT PROVED**: no approved principal, credential input, or issuance path is part
of this task. The existing MCP OAuth service cannot issue the admin audience;
no OAuth change is prescribed. Do not claim routine-admin consumer readiness.

```sh
# step: cd-admin-smoke
# readonly: yes (services; writes nonsecret receipt)
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-admin-smoke: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

test -f "$PROOF_DIR/schema-verified.txt"
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$RELEASE_SHA"
python3 - <<'PYCODE'
import json,urllib.request,urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect())
checks=[('http://127.0.0.1:9000/health','GET',None,{},200,'status','ok'),
 ('https://api.commonswarm.com/functions/v1/read','POST',{'resource':'admin_grants','workspace_id':None,'limit':1,'before':None},{'Authorization':'Bearer swm_adm_release_probe_not_a_credential'},403,'error','credential_kind_forbidden')]
for url,method,data,headers,status,key,expected in checks:
 headers.update({'Content-Type':'application/json','Accept':'application/json'})
 req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),method=method,headers=headers)
 try: response=opener.open(req,timeout=15)
 except urllib.error.HTTPError as error: response=error
 except Exception: raise SystemExit('FAIL cd-admin-smoke: transport; STOP') from None
 with response:
  body=response.read(131073)
  assert response.code==status and len(body)<=131072 and response.headers.get_content_type()=='application/json', 'FAIL cd-admin-smoke: status/media/size; STOP'
  value=json.loads(body); assert value.get(key)==expected, 'FAIL cd-admin-smoke: contract; STOP'
 print('PASS cd-admin-smoke:',method,url,status)
print('NOT PROVED: authenticated admin recovery/command and authenticated MCP tools')
PYCODE
touch "$PROOF_DIR/admin-boundary-probed.txt"
```

## Reserved schema rollback (explicit decision only)

Run cd-schema-rollback once for each highest remaining applied version in reverse
order. The first failure stops; never skip a dependency or batch five inverses.
The rollback file is included verbatim, with its pre-catalog required before
ledger deletion and commit; a failed inverse transaction keeps its ledger.
The empty-admin guard locks private admin tables against races before counting,
rejects any admin events/credentials/grants/history, and requires NULL ancestry.
Old edge must be healthy at the exact baseline and its Compose working_dir
must prove that current is not just a stale symlink. All reserve files use
DROP without CASCADE; an unexpected dependency is a stop. No full restore.

```sh
# step: cd-schema-rollback
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-schema-rollback: line $LINENO; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test ! -e "$PROOF_DIR/closed.txt"
test -f "$PROOF_DIR/session-ready.txt"
. "$DB_SESSION"

SCHEMA_ROLLBACK_APPROVAL=${7:?}; ROLLBACK_VERSION=${8:?}
test "$SCHEMA_ROLLBACK_APPROVAL" = yes
case "$ROLLBACK_VERSION" in 20261001000001|20261001000002|20261001000003|20261001000004|20261001000005) ;; *) exit 1;; esac
(cd "$PROOF_DIR" && sha256sum -c proof-inputs.sha256 >/dev/null)
test "$(readlink -f /home/commonswarm/edge/current)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA"
test "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)" = healthy
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' commonswarm-edge-edge-runtime-1)" = "/home/commonswarm/edge/releases/$BASELINE_EDGE_SHA/deploy/edge-runtime"
release_psql_ro -q --file "$PROOF_DIR/identity.sql"
release_psql_ro -Atq --command "SELECT version FROM supabase_migrations.schema_migrations WHERE version >= '20261001000001' ORDER BY version;" >"$PROOF_DIR/rollback-prefix.txt"
python3 - "$PROOF_DIR/rollback-prefix.txt" "$ROLLBACK_VERSION" <<'PYCODE'
import pathlib,sys
versions=['20261001000001','20261001000002','20261001000003','20261001000004','20261001000005']
rows=pathlib.Path(sys.argv[1]).read_text().splitlines(); assert rows==versions[:versions.index(sys.argv[2])+1], 'FAIL cd-schema-rollback: not highest applied prefix; STOP'
PYCODE
cat >"$APPLY_SQL" <<SQL
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
DO \$empty\$
DECLARE t text; occupied boolean;
BEGIN
 FOREACH t IN ARRAY ARRAY['admin_accounts','admin_grants','admin_consents','admin_credentials','admin_events','admin_command_results','admin_rate_buckets','admin_security_audit','admin_created_workspaces','admin_routine_invitations'] LOOP
  IF to_regclass('swarm.'||t) IS NOT NULL THEN
   EXECUTE format('LOCK TABLE swarm.%I IN ACCESS EXCLUSIVE MODE',t);
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM swarm.%I)',t) INTO occupied;
   IF occupied THEN RAISE EXCEPTION 'C+D rollback refused: admin data exists'; END IF;
  END IF;
 END LOOP;
 LOCK TABLE swarm.agent_principals,swarm.agent_tokens,swarm.events IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.agent_tokens') AND attname='parent_admin_grant_id' AND NOT attisdropped) THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM swarm.agent_tokens WHERE parent_admin_grant_id IS NOT NULL OR recipient_connection_id IS NOT NULL)' INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'C+D rollback refused: worker ancestry exists'; END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM swarm.agent_principals WHERE parent_admin_grant_id IS NOT NULL)' INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'C+D rollback refused: principal ancestry exists'; END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM swarm.events WHERE grant_id IS NOT NULL OR admin_identity_id IS NOT NULL OR grant_manifest_digest IS NOT NULL)' INTO occupied;
  IF occupied THEN RAISE EXCEPTION 'C+D rollback refused: delegated events exist'; END IF;
 END IF;
 IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$ROLLBACK_VERSION') <> 1
 OR EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version>'$ROLLBACK_VERSION') THEN
  RAISE EXCEPTION 'C+D rollback refused: ledger dependency changed';
 END IF;
END \$empty\$;
\i /proof/${ROLLBACK_VERSION}-rollback.sql
\i /proof/${ROLLBACK_VERSION}-rollback-catalog.sql
\if :{?rollback_ok}
SELECT :'rollback_ok'::boolean AS rollback_is_t
\gset
\if :rollback_is_t
\else
DO \$\$ BEGIN RAISE EXCEPTION 'C+D rollback catalog failed'; END \$\$;
\endif
\else
DO \$\$ BEGIN RAISE EXCEPTION 'C+D rollback catalog missing'; END \$\$;
\endif
DELETE FROM supabase_migrations.schema_migrations WHERE version='$ROLLBACK_VERSION';
COMMIT;
SQL
release_psql -q --file "$APPLY_SQL"
test "$(release_psql_ro -Atq --command "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$ROLLBACK_VERSION';")" = 0
printf '\\i /proof/%s-rollback-catalog.sql\nSELECT :\x27rollback_ok\x27::boolean;\n' "$ROLLBACK_VERSION" >"$APPLY_SQL"
test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
printf '\\i /proof/%s-catalog.sql\nSELECT :\x27catalog_ok\x27::boolean;\n' "$ROLLBACK_VERSION" >"$APPLY_SQL"
test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = f
release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' >"$PROOF_DIR/cron-rollback.txt"
cmp -s "$PROOF_DIR/cron-before.txt" "$PROOF_DIR/cron-rollback.txt"
printf 'PASS cd-schema-rollback: %s ledger=0 rollback=t forward=f\n' "$ROLLBACK_VERSION"
```

## Cleanup on success, abort or authorized rollback

cd-schema-close needs only staged state; it works after failed session setup,
reads ledger when a helper exists, and removes the exact secret directory then
uploaded archive. It never removes a release or mutates a service/timer. Proofs
remain under the per-window name, closed.txt prevents forward reuse. If session
fails before state can record a secret path, use cd-open-abort with the printed
path; it never searches for another window's directory. No timers are stopped
by the schema blocks; the edge plan owns and restores its recycle timer.
No raw DB/edge logs, service/pass files or source env enter copyback. Retain
safe ledger/canonical proofs, checksums, status-only probe and 503 receipts.

```sh
# step: cd-schema-close
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-schema-close: line $LINENO; report exact path/error; STOP" >&2' ERR
. "/home/commonswarm/stack/release-proofs/${1:?}-${2:?}/state.sh"
test "$(id -u)" = 0
test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
if test -f "$PROOF_DIR/closed.txt"; then echo 'cd-schema-close: already closed'; exit 0; fi
CLOSE_READBACK_FAILED=0
if test -f "$PROOF_DIR/session-ready.txt"; then
 . "$DB_SESSION"
 if ! release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' >"$PROOF_DIR/closed-ledger.txt"; then
  CLOSE_READBACK_FAILED=1
  printf 'FAIL cd-schema-close: ledger readback failed; continue exact secret cleanup\n' >&2
 fi
fi
if test -n "${SECRET_STAGE:-}" && test -d "$SECRET_STAGE"; then
 python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied), 'FAIL cd-schema-close: deletion boundary control'
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
 /usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cd-schema-close: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
 test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"
fi
if test -n "${SECRET_STAGE:-}"; then test ! -e "$SECRET_STAGE" && test ! -L "$SECRET_STAGE"; fi
test "$CD_BOX_ARCHIVE_PATH" = /tmp/cd-release-${RELEASE_SHA}-${CD_WINDOW_ID}.tar
test ! -L "$CD_BOX_ARCHIVE_PATH"
/usr/bin/rm -f -- "$CD_BOX_ARCHIVE_PATH" || { printf 'FAIL cd-schema-close: cleanup refused %s; STOP\n' "$CD_BOX_ARCHIVE_PATH" >&2; exit 1; }
date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/closed.txt"
printf 'Closed schema window; retain nonsecret evidence %s\n' "$PROOF_DIR"
test "$CLOSE_READBACK_FAILED" = 0
```

```sh
# step: cd-open-abort
# readonly: no
# host: box root /bin/bash 5.2
set -euo pipefail
trap 'echo "FAIL cd-open-abort: retain exact path and guard error; STOP" >&2' ERR
SECRET_STAGE=${9:?exact failed-session path required}
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
python3 - "$SECRET_STAGE" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/anvil-secret.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
assert p.stat().st_uid==0 and p.stat().st_mode & 0o777==0o700
PYCODE
/usr/bin/rm -rf -- "$SECRET_STAGE" || { printf 'FAIL cd-open-abort: cleanup refused %s; STOP\n' "$SECRET_STAGE" >&2; exit 1; }
```

```sh
# step: cd-mac-close
# readonly: no
# host: Mac /bin/bash 3.2
set -euo pipefail
trap 'echo "FAIL cd-mac-close: report exact guarded path/error; STOP" >&2' ERR
: "${CD_ARCHIVE_DIR:?}"
python3 - "$CD_ARCHIVE_DIR" <<'PYCODE'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); pattern=r'/private/tmp/cd-release-archive\.[A-Za-z0-9]{6}'
for denied in ('','/',str(pathlib.Path.home()),'/private/tmp/other','/private/tmp/cd-release-archive.abcdef/child'):
 assert not re.fullmatch(pattern,denied)
assert re.fullmatch(pattern,str(p)) and p.resolve(strict=True)==p and not p.is_symlink() and p.is_dir()
PYCODE
rm -rf -- "$CD_ARCHIVE_DIR" || { printf 'FAIL cd-mac-close: guarded cleanup refused %s; STOP\n' "$CD_ARCHIVE_DIR" >&2; exit 1; }
```


```sh
# step: cd-stage-abort
# readonly: no
# host: box root /bin/bash 5.2; failed staging before state exists only
set -euo pipefail
trap 'echo "FAIL cd-stage-abort: report exact path/error; STOP" >&2' ERR
RELEASE_SHA=${1:?}; CD_WINDOW_ID=${2:?}; CD_BOX_ARCHIVE_PATH=${3:?}; CD_ARCHIVE_SHA256=${4:?}
test "$(id -u)" = 0 && test "$(command -v rm)" = /usr/bin/rm && test -x /usr/bin/rm && test ! -L /usr/bin/rm
python3 - "$RELEASE_SHA" "$CD_WINDOW_ID" "$CD_BOX_ARCHIVE_PATH" "$CD_ARCHIVE_SHA256" <<'PYCODE'
import pathlib,re,sys
s,w,a,h=sys.argv[1:]
assert re.fullmatch('[0-9a-f]{40}',s) and re.fullmatch('[A-Za-z0-9]{6}',w)
assert a==f'/tmp/cd-release-{s}-{w}.tar' and re.fullmatch('[0-9a-f]{64}',h)
p=pathlib.Path(a); assert p.resolve(strict=True)==p and not p.is_symlink() and p.is_file() and p.stat().st_mode & 0o777==0o600
assert not pathlib.Path(f'/home/commonswarm/stack/release-proofs/{s}-{w}/state.sh').exists()
PYCODE
test "$(sha256sum "$CD_BOX_ARCHIVE_PATH" | awk '{print $1}')" = "$CD_ARCHIVE_SHA256"
/usr/bin/rm -f -- "$CD_BOX_ARCHIVE_PATH" || { printf 'FAIL cd-stage-abort: cleanup refused %s; STOP\n' "$CD_BOX_ARCHIVE_PATH" >&2; exit 1; }
```

## Open risks / acceptance limits

- Current SWARM_ENV presence, migration-role identity, backup age, absent ledger
  and catalogs, live override equality and ON runtime identity remain live gates.
- PostgreSQL catalog/rollback execution is **NOT PROVED offline**. The format
  gate and shell parser cannot replace an independent check or a database rehearsal.
- Migration locks may reach 5-second lock timeout under ordinary traffic; a
  failure rolls back that transaction. HezLead decides a new attempt.
- Admin issue/refresh runtime and authenticated recovery/command success have
  no approved smoke principal in this assignment. Boundary rejection is the only
  live admin probe here; do not advertise full delegation availability from it.
- Edge recreation temporarily returns 503 for MCP resource/metadata paths; 240s
  is an approval input, with a measured receipt including rollback. ON recovery
  that exceeds the budget is still a failed window.
- Reserve rollback is only safe before admin use. 02's projection initialization
  and 05's dropped obsolete view are not data-byte inverses; view absence and
  empty admin data are preconditions. Existing worker history is preserved.
- No production window, remote check, independent family review, CI dispatch,
  push, SSH, Docker, browser or 1Password action occurred during preparation.
  HezLead arranges the independent check and exact-SHA gate evidence after merge.
