I'll review the Fold 14 delta only: the outage-survival claim, whether the new status emission can mislead in other orderings, and whether anything else changed. No files will be edited.The range is two commits. I'll read the credential-stop path and the new tests against the round-10 finding.The projection and the stopping sample are in one function. I'll run the two new tests to confirm they actually pin that behavior.The fold holds. With a live token, the credential stop time written to status is the time the listener stops, and the diff does not change any other behavior.

`credentialCheckDelayMs` (`src/listener/runtime.ts:1308-1311`) is the interval for both the projector (`src/listener/runtime.ts:1302-1305`) and the wait (`src/listener/runtime.ts:1374-1376`): 30 seconds while `atMs` is before expiry, five minutes when expiry is absent. The stopping confirmed sample sets `stopAtMs` to that sample and emits it (`src/listener/runtime.ts:1362-1364`) before returning. A credential stop is not restarted (`src/listener/runtime.ts:523-525`). The supervisor copies `stopAt` into `credentialStopAt` (`src/listener/supervisor.ts:672-680`) and clears it when it records `failed` (`src/listener/supervisor.ts:1149-1157`).

The new test (`tests/listener-runtime.test.ts:3484-3522`) is the review order: expiry 30 minutes out, one confirmed read, a 500 at nine minutes, then two more confirmed reads. It schedules three 30-second waits, stops at ten minutes, requires four `credential_check` events, and requires every published `stopAt` to be no later than the real stop, with the last event equal to that stop and no next attempt. Putting the five-minute interval back into the projector makes the nine-minute transient publish a stop past that time, so the test fails. Removing the stopping emit leaves three events, so it fails. I ran that test and the wake test: 2 passed, 0 failed.

The other orderings do not get a false stop from that emit:

- No confirmed answer never opens the window, so the emit does not run (`src/listener/runtime.ts:1371-1372`).
- All confirmed samples keep the ten-minute floor until a sample lands on it; the emit then stamps that sample. On a 30-second grid that sample is the floor.
- After expiry, the window returns at `src/listener/runtime.ts:1334-1336` before the emit. While the projected stop is still past expiry, the status sentence is the expiry sentence (`src/cli.ts:5717-5719`).
- With no expiry, the shared function and the sleep are both five minutes, and the third confirmed sample lands on the ten-minute floor.

`nextAttemptAt` is omitted only when the delay is zero (`src/listener/runtime.ts:1289`). Continuing samples still pass `capWaitMs`, whose floor is one second.

The wake test (`tests/listener-wake.test.ts:918-919`) records `idle_poll` flags `[true, false, false]`. Those polls are empty claims, the mode stays push, and the later two are push-wake claims, so `pushReconcileWait` is false only because of `&& !skipRead` (`src/listener/runtime.ts:2016`). Removing that conjunct makes the flags `[true, true, true]`.

`38fd4d5b..e1a94363` is only those runtime lines, the two tests, the Fold 14 note, the token-free first-check status snapshot, and the lead process-check note in the live-control README. The snapshot’s next attempt is 30 seconds and its stop is the ten-minute floor; the lane note says that run is the first check, not the ten-minute stop.

No findings.

VERDICT: PASS
