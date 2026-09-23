I'll review the listener-outage lane at `38fd4d5b` as a read-only pass: LANE.md first, then the full diff and the stop, lapse, and status paths. No files will be changed and no listener will be started.The checkout is the listener lane. I'll confirm the SHA, read the lane record, and then walk the stop and status paths.Opus passed at `0a47a550` with one wording gap. I'll check the two commits after that, then re-check the stop, lapse, and wait invariants on the full lane.The listener still stops too soon relative to the time status shows, once a live token is in a credential check. The ten-minute floor itself holds. The displayed stop time does not.

## PRODUCTION

**P1. With a live token, status can name a credential stop several minutes after the listener has already stopped.** `src/listener/runtime.ts:1366-1370` and `src/listener/runtime.ts:1296-1356`.

A production credential has an expiry, so every sample in the window waits 30 seconds:

```1366:1370:src/listener/runtime.ts
    const expiry = options.credentialSession.expiry;
    const delayMs = expiry !== null && expiry !== undefined && atMs < expiry
      ? RENEWAL_WINDOW_RETRY_MS : CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS;
    emitCredentialCheck(capWaitMs(delayMs));
    await sleep(delayMs, abort);
```

`RENEWAL_WINDOW_RETRY_MS` is 30 seconds (`src/listener/runtime.ts:149`). The stop ignores that clock and ignores `stopAtMs`. It stops on the first sample that has at least three confirmed answers and is at least ten minutes after the first:

```1352:1356:src/listener/runtime.ts
      if (
        window.checks >= CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS &&
        atMs >= window.startedAtMs + CREDENTIAL_LOSS_CONFIRM_WINDOW_MS
      ) {
        return { reason: "credential", error: asError(error) };
```

The time written to status is projected with the five-minute constant instead:

```1296:1305:src/listener/runtime.ts
  const projectCredentialStopAt = (atMs: number): number => {
    if (credentialWindow === null) return atMs;
    const remaining = Math.max(
      0,
      CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS - credentialWindow.checks,
    );
    return Math.max(
      credentialWindow.startedAtMs + CREDENTIAL_LOSS_CONFIRM_WINDOW_MS,
      atMs + remaining * CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS,
    );
  };
```

A transient keeps the larger of that projection and the old stop time (`src/listener/runtime.ts:1358-1362`). The stopping sample updates `stopAtMs` and returns without emitting, so the status file keeps the previous projection. `src/cli.ts:5717-5721` then says the listener will stop at that time if every remaining check confirms the loss, and that a transient extends the window.

A run of only confirmed answers stays honest: the displayed stop remains the real ten-minute mark, and `nextAttemptAt` matches the 30-second sleep. A 500 between those answers does not. After the opening confirm, one transient while the count is still 1 sets the displayed stop to about ten minutes from that transient. That is later than the real stop by however long the window has already been open. The sample that finally stops the process does not publish a correction.

Concrete order, token expiry 30 minutes out, first confirm at t=0, then 500s, then confirms again near the end:

- t=9:00, still one confirm, transient: displayed stop becomes t=19:00.
- t=9:30, second confirm: displayed stop becomes t=14:30.
- t=10:00, third confirm: both gates pass, the listener stops for good. Nothing restarts it. The last sentence still said t=14:30.

The same shape is the lane’s “500 between confirmed codes” case. It is the outage a person is watching when they decide whether to leave the listener up. Pure 500s never open the window. A five-minute DNS cut of only `forbidden` still survives and shows the true ten-minute stop.

## RIGOUR

**R1. The tests that pin “three reads, elapsed equals ten minutes” use a session with no expiry.** `tests/listener-runtime.test.ts:3318-3336` and `tests/listener-runtime.test.ts:3461-3481`. With `expiry` absent, the sleep is `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS`, so the projector and the sleeper agree and the transient test can finish at fifteen minutes. The expiry-bearing tests (`tests/listener-runtime.test.ts:6858-6904`) check that the stop is not earlier than ten minutes. They never compare `credentialStopAt` with the time the stop happens. A production token always has an expiry (`src/cloud/renewal.ts:831-833`).

**R2. The push-wake wording fix is untested.** `src/listener/runtime.ts:2010` now sets `pushReconcileWait` only when `!skipRead`. No test fails if that conjunct is removed. The 147 passing runtime, wake, and idle-poll tests also passed before the line. The live status from the fault proxy does show the fallback: `idlePollMs` 5000, `pushReconcileWaitMs` null, and the human line “reconcile every 5m” (`docs/evidence/2026-09-22-listener-outage/live-control-20260923T0634Z/status.txt`).

**R3. The live-control artifact stops at `stopping` and records a leftover.** `stop.json` is `state: "stopping"` for pid 51701. `summary.txt` then says `LEFTOVER PROCESS` under the temporary directory. The README says the process was gone seconds later; the saved files do not show that. No process from that directory is running now. The same run acked two real deliveries as `queued` (`lastAckOutcome`, `pendingForMainCount` 2) into a temporary home the script deletes. The README does not say what happened to those two queued messages.

## Checked and still holding

Invariants A, B, and C still hold on this SHA. Every runtime sleep goes through `capWaitMs` (`src/listener/runtime.ts:995-1008`), which keeps the one-second floor and will not schedule past the renewal due time or the 110-second margin. The supervisor restart sleep uses the same bound (`src/listener/supervisor.ts:1081-1091`). One-shot renewal is unchanged by `c88c7b3e` and `38fd4d5b`. Read backoff stays capped at 30 seconds (`src/cloud/signals.ts:169`), inside the five-minute supervisor cap.

A bare HTTP 403, a 500, a timeout, or a network error retries inside the runtime and does not become a permanent stop. Read-edge `forbidden` is only `agent.is_revoked` (`supabase/functions/read/index.ts:474-475`). Command-edge `forbidden` is not a confirmed code (`src/cloud/signals.ts:2373-2376`); after three claim refusals the loop forces a read (`src/listener/runtime.ts:1942-1944`). `h0_seat_uses_poll` stops once, with its own sentence, and is not restarted (`src/listener/runtime.ts:546-553`, `src/cli.ts:5757-5758`). `cswarm listen stop` aborts the window sleep and ends `stopped` (`src/listener/runtime.ts:1370-1371`). A stopped or failed listener does not get the throughput lapse (`src/cli.ts:5414-5441`). Push hours are scored at five minutes (`src/listener/supervisor.ts:530-531`). `ATTENDING: hook` follows the installed settings hook (`src/cli.ts:7752-7771`). The live control shows that path: one HTTP 500 and one HTML 403, then `state: "ready"`, two retries over 2.7 seconds, no lapse, no credential stop. It does not exercise the ten-minute window. The evidence files contain no token. `cswarm follow` still returns on one confirmed read code (`src/cloud/signals.ts:2735-2739`). That is a different command from the two listeners that stopped on 16 and 18 September.

VERDICT: FAIL
