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
capacity; provision reviewed SHA and new read-only deploy key; run focused controls
and all five suites; inspect exact-SHA receipts and historical probes; verify one
timer run; then remove the two old CommonSwarm triggers. Record those receipts
here before claiming migration, scheduler cutover or historical diagnosis complete.
