I'll review this lane read-only: first the lane record and the two diffs, then the stop paths, fatal sets, and status claims.Fold 7 is one commit on top of Round 4. Next I’ll read the prior FAIL notes and walk the parser, renewal, and fatal-set changes.I'll pull Fold 7's source diffs and the parser/runtime files next, then check stop reasons and the AST test.The fold-7 diff is large. I’ll extract fatal sets, stop reasons, parser throw sites, and the AST test next.I’ll read the classifiers, renewal `bearer` path, the AST test, and remaining untagged throws.The AST test only walks same-file function declarations. I’ll check helpers it can miss, then `bearer()` and remaining `DeliveryProtocolError` throws.Round 4’s permanent-stop and untagged-parse classes are closed. The remaining gaps are in the AST walker and in an ACK session test that never runs. No production-stop hole turned up.

## Round 4 status at `a48b1aca`

| Round 4 item | Status |
|---|---|
| Opus P1: one renewal 401/403 was an immediate local stop; a foreign 404 disabled renewal for the process | **Fixed.** Recognized `401 unauthenticated` is `RenewalCredentialCheckError` and enters the window (`src/cloud/renewal.ts:442-444`, `src/listener/runtime.ts:621-623`). Other 401/403/404 become `RenewalOutcomeUnknown` → `RenewalRetryError` while the predecessor is live (`renewal.ts:446, 840-849`). |
| Opus P2: `426 upgrade_required` retried forever | **Fixed.** `[426, "upgrade_required"]` is in `COMMAND_FATAL_ANSWERS` (`runtime.ts:177`). Status uses one installer/npm sentence (`cli.ts:5699-5701, 5755, 6223`). |
| Opus P3: ACK session codes had no operator action | **Fixed in product copy** (`cli.ts:5771-5774`). The ACK test never sends a session code (RIGOUR below). |
| Grok: bad pending count / full page last row stopped for good | **Fixed.** Those throws are `DeliveryMalformedResponseError` / `SignalMalformedError` and retry (`delivery.ts:423-425`, `runtime.ts:1448-1451`). |
| Grok: fatal-pair test could not catch a missing member | **Fixed.** Independent `readPairs` / `commandPairs` are compared to the constants before the behavior loop (`tests/listener-runtime.test.ts:4152-4162`). |

## PRODUCTION

None. Every network answer that used to end the listener in the reported incidents, and in the round-4 probes, either enters the confirmation window, retries with capped backoff, or is a well-formed edge refusal that retry cannot change.

## RIGOUR

**1. The AST walker never sees `parseSignalAttachments`, which still throws a plain `Error`.** `tests/listener-runtime.test.ts:104-141` only walks same-file `function` declarations from `agentSignalPage`, `readAgentSignalDirectory`, `parseClaimSuccess`, `parseAckSuccess`, `successBody`, and `requestSuccessor`. Imported callees are skipped (`functions.has(node.expression.text)` is false). `parseSignalRecord` calls `parseSignalAttachments` with no wrapper:

```521:523:src/cloud/signals.ts
    attachments: parseSignalAttachments(row.attachments, {
      enabled: options.attachmentsEnabled !== false,
    }),
```

```24:26:src/cloud/attachments.ts
  if (!Array.isArray(value) || value.length > SIGNAL_ATTACHMENT_MAX) {
    throw new Error("signal read returned malformed attachments");
  }
```

The listener still survives this: `readPage` uses `tolerateMalformedRows: true` (`runtime.ts:1111-1112`), so `parseSignalRows` counts the row or upgrades to `SignalMalformedError` after three (`signals.ts:587-594`). Claim/ACK wrap `parseSignalRecord` as `DeliveryMalformedResponseError` (`delivery.ts:518-523`). A follow/`readSignals` call with `tolerateMalformedRows: false` (`signals.ts:1675-1677`) would still see an untagged `Error`, which is unclassified and not retryable. That is not the reported listener stop. The Fold 7 claim that every network-response parse throw is a tagged malformed class is false for this helper, and the AST test cannot catch it.

**2. LANE.md says ACK session status is tested. The ACK loop never sends a session code.** Fold 7 added a `session_` branch to `tests/listener-runtime.test.ts:4037-4039`, but the scenarios at `3983-3986` are only HTML 200 and foreign 404. Removing `cli.ts:5772-5774` would leave that test green. Claim session codes are covered (`3836-3839`, `3899-3901`). The product sentence is present and uses `DELIVERY_SESSION_PROOF_CODES`.

**3. Named renewal domain refusals (`RenewalUnsupported`, device `RenewalRefused`) are converted to `RenewalRetryError` until local expiry.** `bearer()` rethrows horizon/suspend/revocation/upgrade (`renewal.ts:835-839`) and retries the rest (`840-849`). A `200 rejected` `renewal_unsupported` is a refusal this binary cannot change; status says “check the command edge if renewal does not recover” (`cli.ts:5720-5721`) rather than the refusal’s own next step. It is not a hot loop (backoff 250 ms–30 s) and expiry is named. After expiry it becomes `RenewalRevoked("predecessor_expired_local")` and a credential stop.

## Checked

**Stop reasons.** `cancelled` on abort in every wait, including credential-window and renewal/claim/ACK backoff. `credential` after three confirmed-loss checks and ≥10 minutes, or immediately for `RenewalRevoked` / `RenewalReauthorisationRequired` / missing local secret. `fatal` for exact `READ_FATAL_ANSWERS` / `COMMAND_FATAL_ANSWERS` pairs (command pairs also need `recognizedEnvelope`), H0, `delivery_configuration_missing`, local journal/effect/validation, `RenewalUpgradeRequiredError`, and untyped local errors. `isRestartableListenerStop` is false for credential, H0, upgrade, and those fatal pairs.

**Fatal sets vs this edge.** Read refusals: `400 invalid_request` (`read/index.ts:409`), `404 channel_not_found` (`read/index.ts:771`; the listener omits `channel`). Read `401 unauthenticated` / `403 forbidden` (`read/index.ts:471, 475`) go through the window; `403 forbidden` on this edge is only `agent.is_revoked`. Read `405 method_not_allowed` retries (`runtime.ts:157-163`; test at `6339-6358`). Command refusals: `400 invalid_request`, `409 command_id_conflict`, `409 delivery_ack_conflict`, `409 delivery_not_surfaced` (status 409 via `session-wire.ts:156-157`), `413 payload_too_large`, `426 upgrade_required` (`command/index.ts:9133-9134`), `403 h0_seat_uses_poll`. Command `401 unauthenticated` is the window. Session codes retry with a session action. `h0-seat.ts` is still not on this branch; the client stops on the pair if it appears.

**Renewal.** Not a hot loop: `sleep` is `nextFollowBackoffMs` / `deliveryRetryDelay`, cap 30 s, jitter ≥ half the ceiling. Status JSON carries `renewalExpiresAt` and `nextAttemptAt` (`supervisor.ts:706, 753`). `CONNECTED` is no while `starting`, `claim_retry`, `ack_retry`, `credential_check`, or a live read episode (`cli.ts:5326-5330`). `cswarm listen stop` aborts those sleeps. One-shot CLI still uses a live predecessor (`renewal.ts:852-858`; `tests/p1-cli/renewal-refusal-cause.test.ts:66-69`).

**Credential window orderings.** Confirmed opens/extends; transient does not count and pushes `stopAt`; success on a completed read clears (`runtime.ts:1468`); abort during the wait is `stopped`. Command-edge `forbidden` is not a confirmed code.

**Follow.** Still stops on one confirmed read code (`isFatalFollowError`). The measured stops were listeners.

**Load.** Read/renewal/claim/ACK retry at the 30 s cap is about two to four status writes per minute per listener. Credential checks are one per five minutes. `426` is one request then stop.

**Tests and scripts.** New runtime tests are in the literal `npm test` list. `tests/p1-cli/renewal-refusal-cause.test.ts` is under `test:p1-cli`. The pending-count and full-page tests drive the real clients (`6174-6219`). The independent pair list includes `426`. Detached artifact `docs/evidence/2026-09-22-listener-outage/fold7-detached-status.json` is `failed` / `upgrade_required` / `nextAttemptAt: null` / `credentialStopAt: null`.

**D-053.** New control flow uses `instanceof` and `error.name === "AbortError"`, not `error.message`. User-facing code lists come from `CONFIRMED_CREDENTIAL_LOSS_CODES`, `COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES`, `DELIVERY_SESSION_PROOF_CODES`, and `CSWARM_UPGRADE_STOP`.

No listener was started. No production host was contacted. Tests were not executed in this review.

VERDICT: PASS
