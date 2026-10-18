# Standalone CI implementation evidence — 2026-10-18

Source baseline: `a29fca08`, branch `fix/hetzner-nightly-20261018`.
Scope: CI-ACCEPT.md SCR1–4 and evidence portion of SCR5. This records prepared
implementation and syntax checks, **not host provisioning or a live scheduler**.

Added the exact-SHA serial controller, workflow-equivalent suite adapter,
bounded retention, isolated tools provisioning and disabled systemd timer.
The box guard accepts CI=true plus STANDALONE_CI=1 or GITHUB_ACTIONS=true;
its Linux/root/production-host/preexisting-path checks remain.
GitHub's schedule and Mac dispatcher remain pending verified timer cutover.

New focused tests exercise actual guard execution in disposable Linux containers,
strict CLI rejection, real git source provenance, flock serialization, failure
aggregation, timeout cleanup, ownership refusal, contention and bounded retention.
The Docker lifecycle fixture supplies only external process behavior; the real
controller creates receipts and makes cleanup/timeout/queue decisions. The suite
adapter invokes this file explicitly in its unit gate; npm test's list is unchanged.

Mini validation: shell syntax (`bash -n`), embedded Python/retention compilation,
Node syntax (`node --check`) and `git diff --check` only. No installs, builds,
suite execution, SSH, Actions dispatch, provisioning, scheduler activation,
production changes, commits or pushes were performed by this Maker.

Historical source/log evidence supplied by CI-PLAN-INNER.md:

| Run | p1-cli failure |
| --- | --- |
| 38507124703, October 14, a681dff7b61d | agent-channel idle canary/session receipt/turn-mode case: deadline condition |
| 38677135955, October 15, 779ad35138a5 | admin-recovery generated read-contract equality |
| 38846361130, October 16, a7e9dc0cfd79 | same contract equality |
| 38999280537, October 17, a7e9dc0cfd79 | contract equality and same channel deadline case |
| 39094174306, October 18, a7e9dc0cfd79 | contract equality; server also failed, cause outside this packet |

The contract source/artifact drift is repeatable historical evidence; no generated
file was changed because Root has not accepted a verified generator diff.
The channel failure remains unclassified until controlled exact-SHA isolated,
full-suite and ten-repeat CI-host probes. No flake claim or timeout change is made.

Root completion gates: independent cross-family review; coordinate pe-ci-1
capacity; provision reviewed SHA using public anonymous HTTPS; run focused controls
and all five suites; inspect exact-SHA receipts and historical probes; verify one
timer run; then remove the two old CommonSwarm triggers. Record those receipts
here before claiming migration, scheduler cutover or historical diagnosis complete.

Follow-up delta against `19f1cc55`: public repository fetch now requires the exact
anonymous HTTPS source URL and ignores inherited/global/system Git configuration;
no CommonSwarm deploy key or SSH config is required. No host Git settings changed.
Active-command polling detects new PE workers, withdraws owned work, preserves a
deferred receipt, and retries the same snapshot when quiet under the original
suite deadline. Cleanup failures stop retrying; expired quiet waits fail with 124.
Focused semantic cases were authored for mid-suite PE arrival/owned cleanup/
deferred receipt/quiet same-SHA completion, public-source configuration isolation,
and bounded contention failure; the existing active-suite timeout case remains.
Delta validation is syntax only on the Mini; Root CI must execute these cases,
all five real suites, historical probes and controlled overlap/memory/withdrawal
measurement before provisioning activation or cutover is claimed complete.


Claude-review repair at 1132ab41: dedicated service account/primary-group and
UID-matched worker image; root-owned scripts with expected checksum admission;
private state; fixed local source config/full main and tags; root worker
SUDO_UID ownership; pinned outer Docker context/socket; loopback DinD API and
published-port default; PE visibility control; persistent stop latch; finite
queue/systemd/cleanup/retention bounds; exclusive fresh-install rollback.
The root box suite now explicitly invokes the site-artifact file supplied by
#86. Root must merge that PR before combined real CI; no site test copied here.
Mini focused semantics: node --test tests/standalone-ci-guard.test.mjs: 18 cases,
17 pass, 0 fail, 1 explicitly skipped Linux/Docker guard case. The platform
boundary alone is mocked on Darwin; real git/flock/clock/process lifecycle and
receipts run against a Docker transport fixture. This is not Linux/root proof.
New cases protect absent origin/main (positive and negative transport), script
tampering/private state, local source rewrite reset, root-process visibility,
and signals during cleanup, queue wait and scratch retention. Original substantive
assertions remain. No full suites, installs/builds, host provisioning, SSH,
workflow dispatch, production writes, commit or push were run.
Runtime gates remain: Root's cross-family review; real Linux controls; fresh
install failure/rollback; dedicated UID/mount ownership and root Git; merged #86
root rendered artifact cases; all five same-SHA suites; PE overlap withdrawal and
measured memory headroom; actual nested loopback bindings; timer stop/owned cleanup;
completed timer receipts; historical p1 probes; only then trigger cutover.
Memory fit is unmeasured. Inputs float at rebuild time despite runtime image pins.
Versioned upgrades and broader supply-chain pinning remain parked as directed.
