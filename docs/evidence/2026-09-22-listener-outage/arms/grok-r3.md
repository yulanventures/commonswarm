I'll review this lane read-only: the evidence record first, then the fold diff and every path that can stop the listener.Round 2 failed on the claim hot loop, unnamed startup retries, and foreign claim answers. I'll check those fixes in the fold commits and look for any path that still stops or spins.The fold claims check out on the claim backoff and startup naming. I'm confirming the remaining stop paths and what status says once a listener is already ready.Round 3 fails. The claim hot loop and the unnamed startup retry are fixed. A listener that is already ready still looks healthy through the outage this lane is for, and one foreign 405 or 409 still ends it for good.

## Fixed since 08c27a3c

Claim backoff now lives outside the claim block (`deliveryAttempt` and `claimRefusals` at `src/listener/runtime.ts:1305-1307`). A retry sleeps before a forced read (`1728-1736`), and only a successful claim clears both (`1746-1749`). With `random() = 1` the eight sleeps are 0.5, 1, 2, 4, 8, 16, 30, 30 seconds and status stays `claim_retry`. That removes the round-2 hot loop. Steady state at the cap is about four claims and one read per 45 seconds on average, plus one status write and one log line per claim.

Startup read failures emit `read_retry` before the first ready event. While state is `starting`, status stores the code and `nextAttemptAt` (`src/listener/supervisor.ts:712-715`). `listen start` names that code and the target URL (`src/cli.ts:6100-6108`).

HTML 200, unrecognized 400/404, and a non-envelope 2xx on claim and ack retry. A recognized `invalid_request` stays fatal and is not restarted. Malformed-row overflow and a delivery marker other than `1` throw `SignalMalformedError` and retry as `malformed_response`. Read-edge `forbidden` is only `agent.is_revoked` (`supabase/functions/read/index.ts:474-475`). Command-edge `forbidden` is not a confirmed code. H0 `h0_seat_uses_poll` stops once with its own sentence and is not restarted. `ATTENDING: hook` follows the installed settings file, using the listener's project directory. Running states come from `LISTENER_RUNNING_STATES`. The new tests are in `npm test` or `npm run test:p1-cli`. The claim-backoff and foreign-claim tests drive the real runtime and client. They are not circular. `cswarm inbox --follow` still stops on one confirmed read code (`src/cloud/signals.ts:2736-2740`). The reported stops were listeners, so that path is not this incident.

The confirmation window still needs three confirmed checks and ten minutes. A transient answer does not count and pushes the stop time out. A successful read or claim clears it. `cswarm listen stop` aborts the sleep. A `retryable: false` HTTP 500 still leaves the runtime (`isRetryableFollowError` is false; `isRestartableReadError` is true) and the supervisor keeps going. After five fast attempts the wait is 2.5 to 5 minutes for the life of the process, because production does not pass `maxAttempts`. A ready run of 60 seconds resets the fast count.

## PRODUCTION

**1. After the listener is ready, a read outage is reported as a healthy listener.** `src/listener/supervisor.ts:709-715`

```709:715:src/listener/supervisor.ts
    if (event.type === "read_retry") {
      status = {
        ...status,
        ...(status.state === "starting" ? {
          lastErrorCode: event.code,
          nextAttemptAt: new Date(Date.parse(event.ts) + event.delayMs).toISOString(),
        } : {}),
```

The 2026-09-16 stop was a listener that was already up. Its detail was `signal read failed (HTTP 403)` with no slug. That answer is now an in-process retry: a probe of `readAgentSignalPage` returned that exact message, `isRetryableFollowError` true. State stays `ready`, so `nextAttemptAt` stays null and `lastErrorCode` stays null. `listenerRetrySentence` runs only for `starting` (`src/cli.ts:5709-5711`). The headline is `Listener ready` (`5779`). `CONNECTED` is yes, because only `starting`, `stopping`, and `credential_check` are excluded (`5322-5324`). The same screen says `No listener process error is recorded.` (`5850-5852`) while the episode line shows HTTP 403 (`5853-5855`).

After 60 seconds the headline becomes `listener_read_retry_persisting` (`5420-5431`). Its next step is to restart the listener if the service looks healthy. The listener is already retrying and should be left running. `nextAttemptAt` is still null. A credential check opened on top of that episode does not clear `readHealth`, so the restart warning is printed under `Listener credential check` as well. The startup test stops on the first sleep, while state is still `starting`, so it never renders this screen.

**2. One foreign 405 or 409 ends the listener, and the supervisor does not start it again.** `src/listener/runtime.ts:511-518` and `578-581`

```511:518:src/listener/runtime.ts
function isForeignReadResponseFailure(error: unknown): boolean {
  // ...
  return http !== null && (http.status === 400 || http.status === 404 ||
    http.status === 426);
}
```

```578:581:src/listener/runtime.ts
function isForeignDeliveryHttpResponse(error: DeliveryHttpError): boolean {
  return !error.recognizedEnvelope &&
    (error.status === 400 || error.status === 404 || error.status === 426);
}
```

Anything else in the 4xx range, other than 401 and 403, is fatal (`src/cloud/signals.ts:2415-2432`, `src/listener/runtime.ts:591-601` and `1460`, `1724-1726`). `isRestartableReadError` and `isRestartableListenerStop` are false for it (`src/cloud/signals.ts:843-844`, `src/listener/runtime.ts:468-474`). A stub-fetcher probe measured:

| Answer | Retry in process | Supervisor restarts |
|---|---|---|
| read HTTP 405 HTML | no | no |
| read HTTP 409 HTML | no | no |
| read HTTP 422 | no | no |
| claim HTTP 405 HTML (`unknown_error`, envelope not recognized) | no | no |
| claim HTTP 409 HTML | no | no |

A POST to a host that is not the command or read edge commonly returns 405. That is the same wrong-host class as the HTML 200 and 404 this fold now retries. Recognized `invalid_request` on 400 staying fatal matches the lane record.

**3. A capable read page with a bad pending count stops the listener once.** `src/cloud/signals.ts:337-345`

```343:344:src/cloud/signals.ts
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("signal read returned a malformed pending_delivery_count");
```

That error is not `SignalMalformedError` and is not in `plainMalformedErrors`. `classifySignalReadFailure` returns `unclassified` (`788-805`). The probe measured `isRetryableFollowError` false and `isRestartableReadError` false. The runtime takes the fatal branch at `1460`. Fold 5's retry covers row overflow and a bad capability marker only. The same page with `delivery_claim: 1` and `pending_delivery_count: "nope"` still ends the process. `safeErrorCode` then records `error`, because the throw is a plain `Error` (`src/listener/supervisor.ts:216-224`).

**4. An acknowledgement retry never returns to a signal read, except one stale `delivery_unavailable`.** `src/listener/runtime.ts:1262-1301`

```1262:1295:src/listener/runtime.ts
        const staleUnavailable = now() >= Date.parse(active.leasedUntil) &&
          error instanceof DeliveryHttpError &&
          error.status === 403 &&
          error.code === "delivery_unavailable";
        if (staleUnavailable) { /* clear and return to reads */ }
        // confirmed unauthenticated enters the window
        if (!isRetryableDeliveryError(error)) {
          return { reason: "fatal", error: asError(error) };
        }
        attempt += 1;
        const delayMs = deliveryRetryDelay(attempt, error, random);
        // sleep and retry the same ACK
```

The claim loop forces a read after three refusals (`1718-1736`). The ack loop has no such exit. A 5xx, a command-edge `forbidden`, or a foreign 404 retries until the process is stopped. On this repository's command edge a revoked delivery ack is `delivery_unavailable` (`supabase/functions/command/index.ts:9044`), and that one answer does reach a read after the lease. Any other lasting ack failure does not, so the read-edge confirmation window never opens. The status line is only `The delivery acknowledgement failed (…). The listener is running and will try again at …` (`src/cli.ts:5782`). It does not say the inbox is not being read.

At the cap, ack retries use the same full jitter as claims: uniform from 0 to 30 seconds, about four requests a minute on average, one status write and one log line each. There is no minimum wait.

## RIGOUR

**5. A `retryable: false` HTTP 500 is recorded as `error`.** The read path throws a plain `Error` (`src/cloud/signals.ts:673-687`). `safeErrorCode` uses `error.name` when there is no `code` (`src/listener/supervisor.ts:216-224`). The probe message is `signal read failed (HTTP 500): internal_error, request_id …`, which matches the 2026-09-18 stop, and the supervisor does keep retrying. The retry sentence says `The last attempt failed (error)`. The HTTP status is only in the detail line.

**6. A 5xx claim is described as a refusal.** `src/cli.ts:5782` says `The command edge did not accept the claim` for every code except `delivery_unreachable`. An HTML 500 claim is `unknown_error` and gets that sentence. It does retry, and it does not mention the credential.

**7. The permanent credential sentence drops the code list.** The failed transition clears `credentialCheckEdge` (`src/listener/supervisor.ts:1077-1087`) and then `credentialStoppedSentence(null)` (`src/cli.ts:5693-5697`) says the server refused the credential, or a local renewal stop fired, or local credential state is missing. The running check sentence still joins `CONFIRMED_CREDENTIAL_LOSS_CODES`. `effectiveListenerStatus` clears `credentialStopAt` and `nextAttemptAt` on an unclean exit and leaves `credentialCheckEdge` and `claimRetryCount` (`1156-1171`).

**8. Delivery backoff has no floor, and the cap test cannot see that.** `deliveryRetryDelay` is `random() * ceiling` (`src/listener/runtime.ts:604-618`). The regression test pins `random() = 1`, so the sleeps are the ceiling. Read backoff floors at half the ceiling (`src/cloud/signals.ts:2139`). Under `Math.random` the claim and ack caps average 15 seconds. A run of low draws has no minimum gap. `isMalformedFollowMessage` still decides `inbox --follow` by `error.message` prefixes (`src/cloud/signals.ts:857-860`). The listener runtime does not use that function.

Credential-check, claim-retry, and ack-retry sleeps are capped at or under five minutes. Read retries after ready are 15 to 30 seconds. None of those states is the round-2 loop of several requests a second.

VERDICT: FAIL
