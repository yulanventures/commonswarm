# Item G lane 2b review follow-ups

The lead's 2026-09-26 landing bar blocks only verified, lane-introduced production findings. This inventory retains the non-blocking findings from rounds 14–16, including findings closed by later folds. Line numbers in the review files refer to their reviewed SHAs.

| Finding | File | Finding | Why it does not block |
|---|---|---|---|
| Codex R14 F1 | `src/cloud/arrival-watch.ts` | A check-then-unlink watcher takeover could remove a newly published owner. | Fold 16 serialized takeover and verifies the moved owner before deletion. |
| Codex R14 F2 | `src/cloud/storage.ts` | A replaced reclaim gate could be moved while another contender inspects it. | Fold 16 compares directory identity and owner bytes before removal. |
| Codex R14 F3 | `scripts/timeout-table/mapping.json` | The lane's release timeout citation pointed at unrelated code. | Folds 15–17 repinned it and added a source-token check. |
| Codex R14 F4 | `tests/p1-cli/host-id-rotation.test.ts` | Real `/bin/ps` controls and full gates had not run at the reviewed SHA. | This was a measurement gap; the lead's Fold 16 service-free and CLI gates were green, while real `ps` remains separately unestablished in this sandbox. |
| Opus R14 F1 | `tests/p1-cli/citation-drift.test.ts` | Fold 15 moved source lines pinned by a citation test. | Fold 16 corrected the citations and the lead's gates passed. |
| Opus R14 F2 | `tests/p1-cli/resume.test.ts` | Idle watcher signal tests expected an unclaimed lease after a successful claim. | Fold 16 corrected the expectation and measured the focused tests. |
| Opus R14 F3 | `src/cli.ts` | A signal stop could claim release while another watcher might hold the lease. | Fold 16 kept a last-known state until release confirms deletion; Fold 17 handles session refusals separately. |
| Opus R14 F4 | `src/cloud/arrival-watch.ts` | A killed publisher's symlink target could be removed before watcher takeover. | Fold 16 retained the active target and tested a killed publisher. |
| Opus R14 F5 | `src/cloud/storage.ts` | A watcher takeover gate timeout used the credential lock name. | Fold 16 gave each lock and gate its actual name, path, and recovery step. |
| Opus R14 F6 | `src/cloud/storage.ts` | A complete replacement gate could be judged using an earlier gate's timestamp. | Fold 16 checks record and directory identity across the stale decision. |
| Opus R14 F7 | `src/cloud/storage.ts` | Publication timing for incomplete lock and gate records was not established on APFS. | Fold 16 uses publication metadata; APFS timing remains a platform measurement, not a verified lane-introduced production fault. |
| Opus R14 F8 | `src/cloud/storage.ts` | General lock takeover and release removed a path after checking an earlier owner. | The pattern predated the lane, and Fold 16 replaced removals with moved-owner verification. |
| Opus R14 F9 | `src/cloud/arrival-watch.ts` | An ownerless watcher timeout said to wait for an owner. | Fold 16 names the lock and prints its exact removal step. |
| Opus R14 F10 | `src/cli.ts` | An aborted claim might have committed despite an unclaimed stop sentence. | Fold 16 covered an in-flight abort; Fold 17 covers a completed transient failure. |
| Opus R14 F11 | `docs/evidence/2026-09-25-item-g-lane2b/LANE.md` | Fold 15 overstated its lease-state control coverage. | Fold 16 records the missed idle watcher tests and supersedes that claim. |
| Opus R14 F12 | `src/cloud/storage.ts` | Complete publication affected every general lock caller, with latency not measured. | Fold 16 inventories those callers; the remaining latency question is not a verified production failure. |
| Codex R15 F1 | `src/cloud/arrival-watch.ts` | “Last renewal” is printed after a claim before any renewal occurs. | This is copy accuracy; the lease state and recovery path remain correct. |
| Codex R15 F2 | `tests/p1-server/h0-poll-ack.test.ts` | A pre-existing server child can inherit `DENO_DIR` on a direct run. | It predates the lane's H0 cases, and the lead's temporary-HOME gate isolates HOME; cache isolation is a follow-up. |
| Opus R15 F5 | `tests/p1-cli/host-id-rotation.test.ts` | Two aged-live controls use the test process's PID and miss a non-self liveness probe. | They still catch age-based removal; a child-PID control would improve coverage without showing a production fault. |
| Opus R15 F6 | `src/cloud/arrival-watch.ts` | A watcher timeout can assert no live owner without probing after its shared deadline. | The window is narrow and was not verified as a lane-introduced production failure. |
| Opus R15 F8 | `src/cloud/arrival-watch.ts` | “Last renewal” may describe a claim before the first renewal. | This is copy accuracy; Codex R15 F1 names the same issue. |

Opus R15 F1–F4 are addressed by Fold 17 rulings AM1–AM4; F7 is the Fold 16 evidence correction in AM5.

| Finding | File | Finding | Why it does not block |
|---|---|---|---|
| Opus R16 R2 | `src/cloud/arrival-watch.ts`, `src/cloud/wake-lease-constants.ts`, `src/cli.ts` | A session refusal stop line says “exit 76” although signal exits can be 130 or 143, and release calls a refusal “during renewal.” | The lead classified this copy mismatch as non-blocking under the production-only landing bar. |
| Opus R16 R3 | `src/resume.ts`, `src/cli.ts` | “Check this seat's wake lease” omits a command and retypes the three-minute label. | This is recovery-copy precision, without a verified lane-introduced production failure. |
| Opus R16 R4 | `src/cloud/storage.ts` | A waiting general lock runs blocking `/bin/ps` probes every 25–100 ms for a live same-host owner. | Latency impact was not measured as a production regression at the reviewed SHA. |
| Opus R16 R5 | `src/cloud/storage.ts` | A reclaim-gate timeout omits owner host and prints “host unknown.” | This is diagnostic copy; the timeout still names the gate and recovery step. |
| Opus R16 R6 | `src/cloud/wake-lease.ts` | A failed response-body read after a 200 header can surface raw instead of as an unknown outcome. | The report did not verify a lane-introduced production failure for this earlier behavior. |
| Opus R16 R7 | `scripts/timeout-table/mapping.json` | Four historical-ref CLI citations point at unrelated lines. | The drift is old reference metadata and outside the production-only landing bar. |
| Codex R16 non-blocking | `tests/p1-cli/host-id-rotation.test.ts` | The Fold 17 reused-PID control wrote only a new-format record, leaving upgrade behavior untested. | Fold 18 adds a main-format control that fails under the prior decision. |
| Codex R16 controls | `tests/p1-cli/wake-lease-cli.test.ts`, `tests/p1-cli/timeout-table.test.ts`, `tests/p1-cli/citation-drift.test.ts` | AM1, AM2, AM4, and AM5 matched their rulings and their controls caught the reviewed reversions. | These are positive review results, without an outstanding production finding. |
| Codex R16 non-blocking | `tests/p1-cli/host-id-rotation.test.ts` | The review ran no tests and reported no real-home access by the lane delta. | Test execution is measured in Fold 18; the isolated temporary-HOME controls do not access the real home. |

Opus R16 R1 is addressed by Fold 18 AO1's one-sided creation-time decision. Codex and Opus R16 P1 are the same production finding addressed there.

## Round 17 (Fold 18 review)

The lead verified Codex R17 item 2 as the lane-introduced production blocker; Fold 19 addresses it. These findings remain outside this bounded fold under the 2026-09-26 landing bar.

| Finding | File | Finding | Why it does not block Fold 19 |
|---|---|---|---|
| Codex R17 item 1 | `src/cloud/storage.ts` | A wall-clock step can make a live same-host owner appear to have a reused PID. | Main also evicted a lock after a forward step exceeding the stale bound; platform clock behavior changes the exposed direction. The lead ruled it outside this fold. |
| Opus R17 F1 | `src/cloud/storage.ts` | A safe-integer PID outside the process API's accepted range raises a TypeError during a liveness probe. | No writer produces that PID; the lead ruled it non-blocking. |
| Opus R17 F2 | `src/cloud/storage.ts` | The creation-time comparison can misjudge a live owner after a platform-dependent wall-clock step. | Same underlying issue as Codex item 1; the lead ruled it outside this fold. |
| Opus R17 F3 | `tests/p1-cli/host-id-rotation.test.ts` | The real `/bin/ps` path for a non-self PID remains unmeasured in this sandbox. | This is a measurement gap, not a verified production failure. |
| Opus R17 F4 | `src/cloud/storage.ts` | Host-id and reclaim-gate records still use a two-sided process-start comparison. | Outside the general-lock finding selected for Fold 19. |
| Opus R17 F5 | `site/src/components/download/WhatHappens.astro` | Two agent-state citations point to unrelated storage code. | The citation error predates this lane. |
