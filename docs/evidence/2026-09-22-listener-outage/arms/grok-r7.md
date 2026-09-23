I'll review this lane read-only: the record first, then the Fold 9 diff against the base and the round-6 SHA, without starting a listener or touching production.The checkout is `2a273f89` on `lane/listener-outage`. Next I’ll read the lane record and the round-6 reviews, then check the Fold 9 invariants against the code.Round 6 failed on a sleep past expiry and one-shot renewal throws. I’ll check Fold 9’s deadline and one-shot behavior against the base renewal code, not the new table.Fold 9 caps every wait at 60 seconds before expiry. I’ll read the renewal and runtime paths, then measure how fast requests run once that deadline has passed.The deadline cap turns later waits into immediate retries. I’ll measure that request rate, and compare one-shot renewal with the base revision, using stubbed calls only.The first rate probe is stuck in a zero-delay loop that never yields to the abort timer. I’ll stop it and measure with a hard call cap.Round 6's five-minute sleep is gone. A live token now retries through a transient between confirmed renewal 401s, and one-shot renewal matches `a9846955` for ordinary answers. The new deadline cap removes the wait entirely for the last 60 seconds, so a fast failure becomes a request storm, then a permanent stop at local expiry.

## PRODUCTION

**After the renewal deadline the listener retries with no delay.** `src/listener/runtime.ts:968-983`, `src/listener/runtime.ts:1321-1323`, `src/listener/supervisor.ts:1074-1105`

For a known expiry, every runtime sleep is capped at `expiry - 60s`. Once `now` is inside that window the cap is 0 and `sleep` returns without waiting:

```980:983:src/listener/runtime.ts
  const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    const capped = capWaitMs(ms);
    if (capped <= 0) return;
    await rawSleep(capped, signal);
```

`holdCredentialWindow` still asks for a 30-second retry while the token is live (`runtime.ts:1321-1323`). The wrapper discards it. The same cap covers read and claim backoff, the 60-second port-exhaustion probe (`runtime.ts:1564-1566`, constant at `runtime.ts:138-139`), the wake wait, and the supervisor restart delay. Inside the window `delayMs` is 0, so `restartSleep` is skipped (`supervisor.ts:1105`).

Measured with the real `runListenerRuntime`, a stub fetcher, and no network. The clock started at the deadline. An in-memory credential store and an instant answer, 800 calls then abort:

| Answer | Rate | Command ids | Sleeps |
|---|---:|---:|---:|
| 401 `unauthenticated` | 21,967/s | 800 new ids | 0 |
| foreign HTML 401 | 27,643/s | 1 replayed id | 0 |
| network error | 42,927/s | 1 | 0 |
| HTTP 500 | 64,490/s | 1 | 0 |
| HTML 404 | 53,874/s | 1 | 0 |
| `renewal_unsupported` | 40,072/s | 800 new ids | 0 |
| `renewal_device_mismatch` | 47,406/s | 800 new ids | 0 |
| rotating mix of the first four | 47,598/s | 201 | 0 |

A real round trip lowers this to about one request per answer, because the code adds no wait of its own. With 20 ms per answer, each of those orderings made 3,000 requests in the 60-second margin (50/s) and then stopped. A 30-second answer, the renewal timeout (`src/cloud/renewal.ts:130`), fit twice in the margin. Confirmed 401s, `renewal_unsupported`, and device mismatch drop the pending command id (`renewal.ts:981-984`), so each one is a new command, not a replay.

This is the outage window the lane is for. Before the deadline, backoff still applies (the foreign and network runs slept on the normal curve, then the floor dropped to zero). For the last minute of a failing renewal, one listener emits thousands of command POSTs. A fast 401 can do far more. The supervisor path is the same shape: a restartable fatal, including the lease contradiction this fold now retries, restarted 80 times in 1.2 s (66/s) with an empty delay list while the clock sat inside the margin.

After local expiry the storm stops. Starting at expiry, one 401, one network error, and one foreign 401 each made a single request and stopped `credential` / `RenewalRevoked` `predecessor_expired_local` (`runtime.ts:1281-1283`). That one-failure stop is what Fold 9 specifies. It is still a permanent stop on one transient or foreign answer the moment the local clock passes expiry.

The 60-second margin does not provide the cushion Fold 9 describes. `RENEW_TIMEOUT_MS` is 30 seconds. A server clock 30 seconds ahead expires the token at client time `expiry - 30s`. The measured 30-second attempts occupy the whole margin and finish at local expiry, which is already 30 seconds after that server expiry. The margin is spent on more attempts, not on one attempt that completes while a skewed server would still accept the token.

## RIGOUR

**Status hides the storm.** `src/listener/supervisor.ts:665-673`, `src/cli.ts:5714-5723`

Every confirmed sample sets `nextAttemptAt` to null and keeps `credentialStopAt` on the ten-minute projection. The new sentence is right about the stop: if `renewalExpiresAt` is earlier, it says the listener stops on the next renewal answer after expiry unless renewal succeeds. It does not say requests are leaving with no delay. On the retry path the sentence says "capped backoff" while the cap in force is zero.

**The generated tests require the zero delay, so the storm passes them.** `tests/listener-runtime.test.ts:6407-6421` and `6477-6497`

The 736-sequence test calls the real runtime. Its sleep assertion rejects any positive sleep that lands past the deadline, and a five-minute sleep would fail it. The runtime never calls that sleep once the cap is zero, so the test clock does not move and the assertion never sees the loop. Every sequence ends in success. The expiry test advances time by one second inside the fetcher and only requires `renewals >= 2`. Both files run under a package script: `tests/listener-runtime.test.ts` and `tests/listener-control.test.ts` are named by `npm test`; `tests/p1-cli/renewal-listener-samples.test.ts` is under `npm run test:p1-cli`.

**Invariant B holds except for a JSON `null` body.** Compared by executing `a9846955:src/cloud/renewal.ts` and the head, 51 stubbed answers, no network. The round-6 set matches the base: `renewal_unsupported`, `renewal_grant_not_found`, both device refusals, and 426 warn and keep a live token; 400 and 404 latch renewal off; 401 and 403 stay fatal; revocation, suspension, reauthorisation, and an empty accepted body still stop. HTTP 500 warns and retries. Three bodies differ, all JSON `null`, because a non-object is caught and replaced with `{}` (`renewal.ts:432-439`):

- `200 null`: base warns and runs the command again; head throws `RenewalRevoked` `successor_not_recoverable` and tells the operator the credential was renewed and the replacement was lost.
- `401 null`: base warns and runs; head throws `RenewalRevoked` `forbidden`.
- `426 null`: both run; the warning text differs.

## Checked

The round-6 ordering is fixed. With four minutes of life left, 401, then a network error, then 401, then a successor, the sleeps were 30 s, 30 s, and 30 s. The successor was adopted about 150 s before the old expiry. No sleep crossed the deadline. Before the deadline, a single foreign, network, or 500 answer did not stop the listener. `cswarm listen stop` is still observed after each wait the runtime actually enters; the zero-delay path checks the abort flag on the next iteration.

VERDICT: FAIL
