I'll review this lane read-only: the lane record first, then the fold commits against the outage rules, without touching production or starting a listener.Round 1 failed on the real read path, the claim loop, and status wording. I'll check those fixes in the fold commits and look for new ways a listener can stop or loop.Round 1’s read-path and claim-window holes are fixed. The forced read that closes the claim hole resets the claim backoff, so a listener whose reads succeed and whose claims keep failing spins without ever reaching the delay cap.

## F1 — PRODUCTION: a forced read resets the claim backoff, so a stuck claim spins

After three retryable claim refusals the loop sets `forceRead` and leaves **before** the delay. The attempt counter is created again at 0 every time the claim block is entered. A successful read then zeroes the refusal count. The next cycle is again only the first two delays.

```1633:1706:src/listener/runtime.ts
        let deliveryAttempt = 0;
        while (result === null && !stop) {
          // ...
            if (claimRefusals >= LISTENER_CLAIM_REFUSALS_BEFORE_READ) {
              forceRead = true;
              break;
            }
            deliveryAttempt += 1;
            const delayMs = deliveryRetryDelay(deliveryAttempt, error, random);
            await sleep(delayMs, abort);
```

```1343:1346:src/listener/runtime.ts
        if (claimRefusals > 0) {
          claimRefusals = 0;
          options.onEvent?.({ type: "claim_retry_cleared", ts: eventTime(now) });
        }
```

`deliveryRetryDelay` is full jitter from 0 up to 500 ms, then 1000 ms (`LISTENER_DELIVERY_RETRY_INITIAL_MS` is 500; the 30 s cap is `LISTENER_DELIVERY_RETRY_MAX_MS`). The third claim does not sleep, and a 429’s Retry-After is not applied on that attempt. If the read returns a normal page, the listener goes straight back into claim. Steady state is three claims and one read per those two short delays, for the life of the process.

That is the route-failure case this lane left on purpose: command-edge `delivery_unavailable` is not a confirmed credential code, and a successful read clears the window (`clearCredentialWindow` on the same success path). A revoked credential still reaches the read and the window. A live credential whose claim keeps failing does not sit at the cap.

The same success clears the visible failure. `claim_retry_cleared` sets state back to `ready` and `lastErrorCode` to null (`src/listener/supervisor.ts:677-684`), so a status check between cycles says the listener is ready.

Durable mode does not route `page.signals`, and the reserved claim command id is reused, so this does not deliver the same row twice or reorder claims. It does repeat the read.

The tests stop on the first forced read. `claim-only delivery refusals force a read and expose revocation` (`tests/listener-runtime.test.ts:3524`) aborts when that read returns `forbidden`. `command-edge forbidden is not a confirmed credential loss` (`:3437`) aborts at claim 4. Neither runs the success cycle or asserts a delay.

## F2 — PRODUCTION: a non-retryable claim or ack stops at once and never forces a read

`isRetryableDeliveryError` is transport, 429, 5xx, and 401/403 that are not a confirmed command code (`src/listener/runtime.ts:572-580`). Anything else is fatal before the refusal count is consulted:

```1696:1698:src/listener/runtime.ts
            if (!retryableClaim) {
              stop = { reason: "fatal", error: asError(error) };
              break;
            }
```

A claim body that is not JSON becomes `DeliveryProtocolError`, including HTTP 200 HTML:

```729:736:src/cloud/delivery.ts
function successBody(response: Response, text: string, verb: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DeliveryProtocolError(
      `${verb} response was not JSON (HTTP ${response.status})`,
    );
  }
}
```

`isRestartableRuntimeError` returns false for `DeliveryProtocolError` and for a delivery 400 (`src/listener/runtime.ts:464-472`). The supervisor does not start again. Push mode can take this path with no read first (`skipRead` at `src/listener/runtime.ts:1314-1316`). The same 400, 404, 426, and HTML 200 on the **read** path now retry (`isForeignReadResponseFailure`, `src/listener/runtime.ts:505-512`). A misrouted host that answers the claim that way still ends the listener for good. The ack loop has the same fatal branch (`src/listener/runtime.ts:1270-1271`) and no forced read; a retryable ack waits only until the lease, then the outer loop can read.

## F3 — PRODUCTION: before the first ready read, status says there is no retry episode

`read_retry` is emitted only after `ready`:

```1417:1425:src/listener/runtime.ts
          if (ready) {
            const failedAtMs = now();
            if (readEpisodeStartedAtMs === null) {
              readEpisodeStartedAtMs = failedAtMs;
              readEpisodeAttempts = 0;
            }
            readEpisodeAttempts += 1;
            options.onEvent?.({
              type: "read_retry",
```

Until that event, status always prints:

```5839:5841:src/cli.ts
    readHealth.currentEpisodeStartedAt === null
      ? "Current read retry episode: none."
      : `Current read retry episode: ${readHealth.currentEpisodeAttempts} attempt${...}`
```

A bare 403, a 5xx the server did not mark `retryable: false`, a 400/404/426, or a missing read capability now stays inside the runtime instead of failing the process. If that happens before the first successful read, state stays `starting`, `nextAttemptAt` stays null, and the episode line says none while the loop is sleeping and trying again. The capability failure sentence (`src/cli.ts:6221-6225`) is only used when the process has already failed, so it does not appear. A listener that has already been ready does record the episode; the measured stops were in that state.

## F4 — RIGOUR: malformed read rows still stop the listener for good

Fold 2 says malformed read rows retry with capped backoff. The listener asks `readAgentSignalPage` to tolerate rows, and the overflow throw is an ordinary `Error`, not a tagged malformed error:

```582:585:src/cloud/signals.ts
      if (malformedRows > options.maxMalformedRows) {
        throw new Error(
          `signal read returned too many malformed rows (more than ${options.maxMalformedRows})`,
        );
```

`isForeignReadResponseFailure` retries only `ListenerCapabilityError`, `classifySignalReadFailure` code `malformed_response` (the WeakSet / `SignalMalformedError`), and HTTP 400/404/426 (`src/listener/runtime.ts:505-512`). This error is `unclassified`. The runtime stops, and the supervisor does not restart it. A delivery capability marker that is present and not exactly `1` is the same kind of untagged `Error` (`src/cloud/signals.ts:299-301`). The foreign-response test (`tests/listener-runtime.test.ts:3565`) covers 400, 404, 426, and HTML 200 only. Those four do retry.

## Checked, and not a fail

The plain error from `throwSignalHttp` reaches the window. `isLocalCredentialLoss` returns false when `followHttpDetails` is set (`src/listener/runtime.ts:537-542`), and `isServerConfirmedCredentialLoss` then uses the read-edge code list (`:552-563`). `real signal read HTTP codes enter the listener confirmation window` drives `readAgentSignalPage` with a stub `fetcher` and expects `cancelled` plus one `credential_check`, not an immediate credential stop (`tests/listener-runtime.test.ts:3477`).

Read-edge `forbidden` is only `agent.is_revoked` (`supabase/functions/read/index.ts:474-475`). The other auth refusals there are 401 `unauthenticated` (`:388`, `:416`, `:422`, `:471`). Command-edge `forbidden` is not in `COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES` (`src/cloud/signals.ts:2365-2368`).

Three retryable claim refusals do force a read, and a confirmed read code opens the window. Revocation is not stuck forever without a classification. The hot loop above is the case where that read succeeds.

`nextAttemptAt` is cleared when the next supervisor attempt starts (`src/listener/supervisor.ts:1022`). The credential-check sentence names the answering edge’s code list and says a transient answer extends the window (`src/cli.ts:5699-5705`). `listen status` checks the hook from `status.projectDirectory` (`src/cli.ts:7271-7273`, `:7659-7663`). `listen start` treats `credential_check` and `claim_retry` as running (`src/cli.ts:6889-6893`, `src/listener/supervisor.ts:1190-1191`). A missing local secret is `LocalCredentialSecretAbsentError`; the stop path does not test `error.message`. The H0 sentence says to stop and that nothing else is needed (`src/cloud/delivery.ts:85-86`). The live-control write test returns `AcpProtocolError` and has a 15 s timeout (`tests/listener-control.test.ts:1838-1859`). New tests sit in `npm test` or `npm run test:p1-cli`.

`cswarm inbox --follow` still stops on one confirmed read code. The measured stops were listeners (`listener_failed` / `credential_stopped` and `restarts_exhausted`), so that path is not the reported case.

A journal error, an ACP configuration or protocol error, `delivery_configuration_missing`, and an untyped exception still end the process and are not restarted. The forever retries are the widened read-response classes (400/404/426, tagged malformed JSON, missing server capabilities), including when the server keeps sending them.

Window spacing is the five-minute interval; three confirmed checks cannot complete before ten minutes unless the clock jumps. `cswarm listen stop` aborts `defaultSleep` and `defaultRestartSleep`, and both clear the timer. Production `runListenerSupervisor` does not pass `restart.maxAttempts`, so a restartable exit (a 500 with `retryable: false`) keeps going at the sustained cap of five minutes.

VERDICT: FAIL
