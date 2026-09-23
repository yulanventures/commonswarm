I'll review the listener-outage lane as a read-only check of invariants A, B, and C, starting with the lane record and the fold 10 claim.Round 7 failed on a zero-wait storm after the renewal deadline. I'll read Fold 10's diff and the wait, renewal, and status paths before measuring rates.The deadline cap is off until renewal is already due, while a push listener can wait five minutes. I'll measure that against the 92-second margin, the request rate, and one-shot renewal at the base revision.The one-second floor stops the request storm. The 92-second renewal margin does not hold for a push listener whose reconcile wait begins before renewal is due.

## PRODUCTION

**A push reconcile wait that starts before renewal is due runs past the deadline.** `src/listener/runtime.ts:1473-1474`, `src/listener/runtime.ts:983-988`, `src/listener/runtime.ts:1230-1235`, `src/listener/wake.ts:14`, `src/cloud/renewal.ts:139-146`

The deadline cap is applied only when `renewalDue` is already true. A presented credential is treated as a one-hour token, so renewal becomes due six minutes before expiry (`renewalDueAt` lead is 360 seconds). The deadline is 92 seconds before expiry, so the gap from due to deadline is 268 seconds. Push reconcile is 300 seconds:

```1473:1474:src/listener/runtime.ts
        const until = Math.min(reconcileDueAt, now() + waitCapMs(),
          options.credentialSession.renewalDue === false ? Infinity : renewalDeadline() ?? Infinity);
```

`mayWaitForWake()` is true for that whole wait, and `wake.next` sleeps until the `until` captured at the start (`src/listener/wake.ts:367-368`). Nothing rechecks the deadline when the token becomes due.

Measured with `runListenerRuntime`, a stub fetcher, and a fake clock, no network. The wait started 1 ms before due (`renewalDue` false) and lasted 300,000 ms. It ended 31,999 ms after the deadline. The first renewal then started with 30,001 ms left before a server clock 30 seconds ahead. One 30-second timeout (`RENEW_TIMEOUT_MS` at `src/cloud/renewal.ts:130`) finishes 1 ms before that server expiry. The next attempt starts about 1 second after the server token is dead. Fold 10’s two full timeouts inside the server window do not fit. A quiet push listener hits this wait once per token; the overshoot is up to 32 seconds when the wait starts in the last 32 seconds before due.

The supervisor uses the same predicate and the same five-minute sustained delay (`src/listener/supervisor.ts:68`, `src/listener/supervisor.ts:1078-1082`). A restart sleep that starts just before due has the same 32-second overshoot. That path was read from the code; the executed measurement is the wake path.

Poll mode does not do this. Its idle cap is 60 seconds (`IDLE_POLL_MAX_MS`), which fits inside the 268-second gap.

## RIGOUR

**The generated tests never take the push wait.** `tests/listener-runtime.test.ts:6457-6472` and `tests/listener-runtime.test.ts:6527-6537`

The 736 and 64 sequences drive renewal with no wake subscriber, so `until` is never computed. Forcing `capWaitMs` to return 0 after the deadline does fail both tests: they assert `nextAttemptAt` and `delayMs` are at least one second (`tests/listener-runtime.test.ts:6463` and `:6533`). That checks the reported wait, not this reconcile sleep.

**The 92-second sum lands on the server-expiry instant, and the timeout starts late.** `src/listener/runtime.ts:151-152`, `src/cloud/renewal.ts:970-974`

`2 × 30 s + 30 s + 2 × 1 s = 92 s`. An attempt that starts one second after the deadline, then takes a full timeout, a one-second floor, and a second timeout, finishes as the server clock reaches expiry. `exchange` writes the pending command before `requestSuccessor` starts the 30-second timer, so that write sits outside the sum.

**Status reports a five-minute idle interval while a due session’s next wake is the deadline.** `src/listener/runtime.ts:1977-1985`, `src/cli.ts:5904-5906`, `src/listener/wake.ts:211-213`

On a run where renewal was already due, the wake waited 268 seconds and ended on the deadline. The `idle_poll` event still carried `intervalMs` 300,000. Status then says the current idle poll interval is 5 minutes, and the wake line says reconcile every 5 minutes.

**The null-store assertion allows the one-per-second rate.** `tests/listener-runtime.test.ts:6581-6582`

The bound is `ceil(92 s / 1 s) + 1`, which is 93 reads. A measured null-store listener kept the idle curve: gaps of 15 s, 30 s, then 60 s, and 2 reads inside the margin. The test would also pass a null store that had sped up to one read per second.

**`426 upgrade_required` still stops the listener on one answer.** `src/cloud/renewal.ts:900`, rethrown before the retry classification. Fold 9 names this as the version stop. A DNS switch onto another deployment with a higher minimum still ends the listener on that single answer.

## Checked

The renewal-loop floor holds. With a stub round trip of 0 ms or 20 ms, confirmed 401, foreign 401, network error, HTTP 500, `renewal_unsupported`, and device mismatch each kept at least 1,000 ms between requests. In the 92-second margin that is about one request per second per listener (90–92 calls). Each of those calls emits one `credential_check` or `read_retry`. The supervisor persists and logs each of those events (`src/listener/supervisor.ts:666-682` and `:754-787`), so the write rate matches the request rate.

A fleet of about 20 listeners is therefore about **20 requests per second**, and about **20 status-file writes and 20 log lines per second**, for those 92 seconds. Before the deadline the same failures wait 30 seconds (`RENEWAL_WINDOW_RETRY_MS`), about 0.7 requests per second for the fleet. After local expiry there is one more request, then `predecessor_expired_local`. The stop text is “The current credential expired before it could be renewed.” That one-per-second cap is enough for this outage; the miss is the reconcile wait that starts late, not the retry rate once renewal is already due.

Invariant B matches `a9846955`. The same stubbed `bearer()` cases, 39 of them, including JSON `null` on 200, 401, 403, 426, 400, and 404, live and expired, and a second call for the 400/404 latch, were identical in outcome, message, warnings, and fetch count.

A null store keeps `renewalDue` false and the idle cadence above. Listener mode never sets the one-shot `unsupported` latch (`src/cloud/renewal.ts:914-916` is after the listener rethrow), so `renewal_unsupported` keeps retrying until local expiry rather than dropping back to the idle poll. A transient answer before expiry did not stop the process. `cswarm listen stop` still aborts the waits the runtime actually enters. The new branches classify with `instanceof` and error classes.

VERDICT: FAIL
