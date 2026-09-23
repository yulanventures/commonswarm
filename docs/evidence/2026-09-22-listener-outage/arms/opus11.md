# Opus arm, round 11 — lane/listener-outage, delta 38fd4d5b..e1a94363 (fold 14 + 78425a1c)

Scope read: `git diff 38fd4d5b..e1a94363` (6 files; only `src/listener/runtime.ts` changes in `src/`, +11/-5), with
`git show e1a94363:` context for runtime.ts 975-1010, 1257-1380, 1448-1466, 2005-2020, 2285-2300, supervisor.ts
445-500, 672-710, 1060-1160, cli.ts 5322-5334, 5706-5722, 5795-5812. Probes: tsx from a temporary directory under
/private/tmp importing the e1a94363 worktree `src/` by absolute path, stub `readPage`, fake clock, no network; the two
changed tests and five mutations were run on a temporary copy of the worktree's `src/` + `tests/`. The worktree is
unchanged (HEAD e1a94363, clean status); the temporary directory is removed. No listener or process was started.

## Claim check (fold 14)

1. **Projection and sleep use one function.** Holds for the uncapped interval. `credentialCheckDelayMs`
   (runtime.ts:1308-1312) feeds the projection (1304) and the sleep (1374-1376). See R1 for the renewal-boundary cap.
2. **The stopping sample is emitted.** runtime.ts:1362-1364 sets `stopAtMs = atMs` and calls `emitCredentialCheck(0)`;
   1289 omits `nextAttemptAt` only for `delayMs <= 0`. Every other caller passes `capWaitMs(...)`, which is at least
   `LISTENER_REQUEST_WAIT_FLOOR_MS` (1 s, runtime.ts:995-999), so only the stopping sample omits it. The supervisor
   maps the omitted field to `nextAttemptAt: null` (supervisor.ts:680), then `transition("failed", { credentialStopAt:
   null, nextAttemptAt: null, ... })` (supervisor.ts:1143-1157) after the runtime returns.
3. **Grok R10 order.** The new test (tests/listener-runtime.test.ts:3484-3522) passed on the copy (1/1). My probe
   reproduced it independently: live token (expiry +30 min), confirm at 0, 500 at 9:00, confirms after. Stop at
   600 s, 4 reads, every sleep 30 s, 0 emitted `stopAt` values later than the actual stop, and the last event states
   600 s with no next attempt.
4. **Mutation controls** (temporary copy, run by test name):
   - The 5-minute projector restored at 1304 fails the new test (0/1).
   - `emitCredentialCheck(0)` removed fails the new test (0/1).
   - `nextAttemptAt` always emitted fails the new test (0/1).
   - `&& !skipRead` removed at 2015 fails the wake test (tests/listener-wake.test.ts:909-919, 0/1). The unmutated
     version passes (1/1).
   - `window.stopAtMs = atMs` removed at 1362 SURVIVES. This is expected: at a stopping sample `remaining` is 0 and
     `atMs >= startedAtMs + WINDOW`, so `projectCredentialStopAt(atMs)` at 1355 already returns `atMs`. The line is
     redundant, not an untested gap.
5. **Gates.** Both changed test files are named in the literal `npm test` script (one occurrence each). Neither file
   contains `child_process`, `spawn`, or `execFile`.

## Other states and orderings (probe, fake clock, stop time compared with every emitted `stopAt`)

| Case | Stop | Reads | Emitted stops later than actual |
|---|---|---:|---:|
| live token, all confirmed | `credential` at 600 s | 21 | 0 |
| live, Grok order (500 at 9:00) | 600 s | 4 | 0 |
| live, 500s from 9:30 to 10:30 | 630 s | 22 | 0 |
| live, alternating confirm/500 | 600 s | 21 | 0 |
| no expiry, all confirmed | 600 s | 3 | 0 |
| no expiry, one 500 | 900 s | 4 | 0 |
| no expiry, alternating | 1200 s | 5 | 0 |
| expiry at +6 min, inside the window (see below) | `credential` `predecessor_expired_local` at 360 s | 120 | 119 |
| live, window crosses the renewal boundary (R1) | 670 s | 24 | 2 (each 20 s) |
| only 500s, no confirm (300 reads, then abort) | `cancelled` | 301 | no `credential_check` emitted |

- **No confirmed answer:** `holdCredentialWindow("transient")` with no window returns `"continue"` (runtime.ts:1371-1372).
  It emits nothing, and the fold does not change that path.
- **After expiry:** runtime.ts:1334-1337 returns before the new emission, so there is no stopping emission on that
  path. The 119 "later" samples all carry `renewalExpiresAt` earlier than `stopAt`. For that state
  `credentialCheckSentence` (cli.ts:5717-5719) does not name the stop time. It says the listener stops on the next
  renewal answer after expiry, and that is what happens. The status stays honest.
- **Stop during a check:** `cswarm listen stop` can land while the stopping request is in flight. The new emission then
  replaces `stopping` with `credential_check` until `failed`. A non-stopping emission already did the same before this
  fold (supervisor.ts:673 has no guard for `stopping`), and the final state is still `failed`/`credential_stopped`.
  This is not a regression.

## Findings

**R1 (RIGOUR): the projection does not include the `capWaitMs` cap that the sleep applies, so for at most one sample
interval near the renewal boundary the stated stop can be up to about 58 s later than the real stop.**
runtime.ts:1304 projects `atMs + remaining * credentialCheckDelayMs(atMs)` with the uncapped 30 s. The sleep wrapper
(runtime.ts:1004-1008) actually sleeps `capWaitMs(ms)`, which shortens the wait to the renewal boundary
(`renewalAt`, or `expiry - 110 s`) and then to the 1 s floor. Probe: expiry +13 min (boundary at 11:10), confirm at 0,
500s until 10:54, then confirms. At 630 s the emitted `stopAt` is 690 s; at 660 s it is 690 s with `nextAttemptAt`
670 s; the listener stops at 670 s, and the stopping emission then states 670 s. The discrepancy has these bounds:
- It is at most `remaining × (30 s − 1 s)` ≤ 58 s.
- It occurs only while the listener waits for its next sample. The `nextAttemptAt` shown for that wait is correct (it
  already uses `capWaitMs`).
- It is replaced by the correct value at the next sample, and the stopping sample always publishes the real time.
- Once `stopAt` passes the expiry, cli.ts:5717 changes to the sentence that names no time.

This does not repeat Grok's P1 (minutes, and never corrected before the stop). The LANE.md fold 14 sentence
"the projection and its next sleep now choose their interval through the same function" is true of the interval
before the cap, not of the wait that occurs. The fix is small: project with `capWaitMs` applied at each step, or note
the cap in LANE.md. This finding does not block.

**R2 (RIGOUR): for the teardown seconds after a credential stop, status reads "still running … will stop at T" with
T ≤ now.** After `emitCredentialCheck(0)`, the runtime runs `wakeSubscriber.close()` and `model.close()`
(runtime.ts:2285-2298). Only then does the supervisor write `failed`. During that time `credentialCheckSentence`
(cli.ts:5721) states a stop time that has just passed. Before this fold, that time was an older projection, which could
be later (Grok P1). The new value is the real one, so this is an improvement, not a regression. A reader who looks in
that window sees a past "will stop at". This is cosmetic and does not block.

**Note (carried, not in this delta):** Grok R10 R3 asked what happened to the two deliveries the live control acked as
`queued` into the deleted temporary home. 78425a1c adds the process check only (live-control README, lines 16-20). That
question is still unanswered in the artifact.

## Nothing else changed

The `src/` delta is limited to runtime.ts 1289, 1304, 1308-1312, 1362-1363, 1374. The remaining changes are these:
- Two tests.
- LANE.md fold 14.
- A token-free status JSON with a loopback `targetUrl` and no `token`, `eyJ`, `bearer`, or `secret` string. It shows
  `credential_check` with `nextAttemptAt` equal to +30 s and `credentialStopAt` equal to +10 min at check 1, which
  matches the new projection.
- The README process note.

No stop reason, restart path, backoff, lapse, or claim path changed.

## Not established

- I did not run the full suites, the detached-listener test, or `build-release.sh`. The LANE.md gate table is the
  Maker's record.
- The probe session had no real renewal (`bearer()` never moves `expiry`), so the renewal-success orderings inside a
  window were not exercised.

VERDICT: PASS
