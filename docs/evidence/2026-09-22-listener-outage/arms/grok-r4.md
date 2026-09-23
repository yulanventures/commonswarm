I'll review the listener-outage lane at `4bd26f53` as a read-only check: the lane record first, then every stop path and the Fold 6 fatal-answer sets.Fold 6 inverts the classifier. I'll read the prior FAIL notes and then check every fatal pair against the edge that produces it.The fatal sets are the decision point. I'll read each producer and every path that can still stop the listener.The fatal-set change is in place. I'll run a local stub probe of the answers that still retry, and of what status says while they do.Round 4 fails. Fold 6 does retry an unrecognized 405, 408, 409, 413, 421, or 422, and a claim `session_expired` now names the session and shows `CONNECTED: no`. Three network answers still end the listener or spin without a next step a person can act on. The probes were in-process against a stub fetcher. No listener process was started and no production host was contacted.

## PRODUCTION

**1. One accepted claim body with a bad pending count stops the listener for good.** `src/cloud/delivery.ts:413` and `src/listener/runtime.ts:1790`.

```413:418:src/cloud/delivery.ts
function checkedNonNegativeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryProtocolError(
      `delivery response returned a malformed ${field}`,
    );
```

```1790:1792:src/listener/runtime.ts
            if (!retryableClaim) {
              stop = { reason: "fatal", error: asError(error) };
              break;
```

`isRetryableDeliveryError` (`runtime.ts:647`) retries only a transport error, a `DeliveryResponseError`, or a `DeliveryHttpError` outside `COMMAND_FATAL_ANSWERS`. `DeliveryProtocolError` is none of those, and `isRestartableRuntimeError` returns false for it (`runtime.ts:533`). A stub claim of HTTP 200 `{"ok":true,"status":"accepted",...,"pending_delivery_count":"bad"}` stopped on the first claim: `fatal`, `restartable: false`, message `delivery response returned a malformed pending_delivery_count`. The same field on a read page is `SignalMalformedError` and retries (`signals.ts:344`, covered by the malformed-read test). A partial success from another host still has the shape of the reported stops: one answer, `restartable` false, nothing starts the listener again.

**2. A full read page whose last row is malformed stops the listener for good.** `src/cloud/signals.ts:1271` and `src/listener/runtime.ts:2128`.

The read parser tolerates up to three bad rows, then sets the cursor from the last raw row. `cursorFromUnknown` returns null when that row is not a cursor (`signals.ts:568`). With limit 100, one tail row `{id:"not-a-uuid"}` and 99 valid rows parsed as `rawCount: 100`, `malformedRows: 1`, `nextCursor: null`. The runtime then does this:

```2128:2136:src/listener/runtime.ts
      const fullPage = page.rawCount >= pageLimit;
      if (fullPage) {
        if (page.nextCursor === null) {
          stop = {
            reason: "fatal",
            error: new Error(
              "the read service returned a full page without a safe cursor",
            ),
```

That plain `Error` is not in `READ_FATAL_ANSWERS` and `isRestartableListenerStop` is false. A stub page of that shape stopped the same way. A later restart reads the same page and stops again.

**3. `upgrade_required` retries for the life of the process, and status tells the operator to wait.** `supabase/functions/command/index.ts:9122` and `src/cli.ts:5758`.

The command edge returns this after auth, for every command including claim and ack, when `client_version` is below `min_client_version`:

```9122:9135:supabase/functions/command/index.ts
    if (versionOrder < 0) {
      ...
      return {
        status: 426,
        body: { error: "upgrade_required", min_client_version: minClientVersion },
      };
    }
```

That pair is not in `COMMAND_FATAL_ANSWERS` (`runtime.ts:167`). The same request cannot succeed until the binary changes. A stub claim of `426 {"error":"upgrade_required"}` kept going (`claim_retry:upgrade_required`, sleeps 500 then 1000, stop only because the probe aborted). Rendered status:

> The claim failed (upgrade_required) 1 times. The command edge did not accept the claim. The listener is running and will try again at …, reading signals after repeated failures.

An ack of the same code says the inbox is waiting and the listener will try again and read signals. Neither sentence says to upgrade `cswarm`. `CONNECTED` is no, which is accurate, and the next step is not.

**4. An acknowledgement `session_expired` retries with the wrong next step.** `src/cli.ts:5760` and `supabase/functions/command/index.ts:8918`.

The session fence runs for ack as well as claim (`command/index.ts:8918-8943`). `session_proof_missing`, `session_proof_invalid`, `session_expired`, and `session_conflict` are recognized (`delivery.ts:97`). Only the claim sentence uses them:

```5754:5762:src/cli.ts
  if (status.state === "claim_retry") {
    if (DELIVERY_SESSION_PROOF_CODES.includes(code)) {
      return `The claim is refused (${code}); this managed seat needs a live session. ... Start or renew the seat's session, or stop the listener. ...`;
    }
    ...
  }
  if (status.state === "ack_retry") {
    return `The delivery acknowledgement failed (${code}). The inbox is waiting on this acknowledgement. The listener will try again${when} and read signals after repeated failures.`;
  }
```

A stub ack of `401 {"error":"session_expired"}` emitted `ack_retry:session_expired` twice and did not stop. Rendered status says to try again and read signals. The read edge does not check the session, so those reads succeed and the ack is sent again. Renewing the session is the action that changes the answer. Fold 6's record says status tells the operator to start or renew the session. That sentence exists for `claim_retry` only.

## RIGOUR

**5. The fatal-pair test cannot catch a missing member.** `tests/listener-runtime.test.ts:4098` walks `READ_FATAL_ANSWERS.refusals` and `COMMAND_FATAL_ANSWERS.refusals` and expects each pair to stop. `upgrade_required` is absent from the constant, so that test stays green. The foreign-claim cases use HTML or `missing_route`, not `426 {"error":"upgrade_required"}`, and no test renders an `ack_retry` session code.

**6. There is no producer of `h0_seat_uses_poll` in this checkout.** `COMMAND_FATAL_ANSWERS` includes `[403, H0_SEAT_CLAIM_REFUSED_CODE]` (`runtime.ts:173`). `src/cloud/delivery.ts:82` names `supabase/functions/command/h0-seat.ts`. That file is not on this branch. The client stops once if it sees the pair. The live edge answer is unestablished, which the lane record already says.

**7. A permanent credential stop drops the code names.** The failed transition clears `credentialCheckEdge` (`supervisor.ts:1129`). `credentialStoppedSentence(null)` (`cli.ts:5697`) then omits `unauthenticated or forbidden` and lists a server refusal, a local renewal stop, and missing local state together.

## Checked

`READ_FATAL_ANSWERS` and `COMMAND_FATAL_ANSWERS` otherwise match refusals this edge actually emits, and a repeat of the same request does not change them. Read `401 unauthenticated` is an unknown or expired token (`read/index.ts:471`) and `403 forbidden` is only `agent.is_revoked` (`read/index.ts:475`). Both go through the three-check, ten-minute window (`runtime.ts:140-150`, `1249-1253`). Read `400 invalid_request` is a body `parseBody` rejected (`read/index.ts:409`). Read `404 channel_not_found` is an unknown slug (`read/index.ts:770`); the listener omits `channel` (`signals.ts:1185`). Read `405 method_not_allowed` is a non-POST (`read/index.ts:384`); this client POSTs (`signals.ts:1168`). HTML 405 retries; the exact pair stops. Command `400 invalid_request`, `409 command_id_conflict`, `409 delivery_ack_conflict`, `409 delivery_not_surfaced`, and `413 payload_too_large` are the same request failing again (`command/index.ts:11189`, `9374`, `11079`, `11397`, `11402`, `1405`). Command `401 unauthenticated` is the window, not an immediate stop (`command/index.ts:8915`).

A bare 403, a 500, and an unrecognized 4xx stay in the process. Backoff is capped at 30 seconds with a floor of half the ceiling (`runtime.ts:658-672`, `signals.ts:2129-2139`). `cswarm listen stop` aborts those sleeps. After a ready run of 60 seconds the fast restart count resets (`supervisor.ts:1054-1057`). A stopped or failed listener does not get the claim-lapse notice (`cli.ts:5414`). `ATTENDING: hook` follows the installed settings file (`cli.ts:7725-7741`). The H0 stop is its own code and is not restarted. `cswarm follow` still leaves on one confirmed read code, and `isFatalFollowError` (`signals.ts:2445`) also leaves on any other 4xx. The reported stops were listeners, so that path is not this incident. The new tests sit in `npm test` or `npm run test:p1-cli`.

`fold6-detached-status.json` shows `claim_retry`, `http_405`, `nextAttemptAt`, `targetUrl`, and `credentialStopAt: null`.

VERDICT: FAIL
