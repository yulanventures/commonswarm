# D-036 Checker (Claude Opus), round 5: lane/listener-outage @ a48b1aca

Base a9846955. I read brief5, LANE.md through "Fold 7", both round-4 reviews, `git diff 4bd26f53...a48b1aca`, and
the code at a48b1aca in the detached worktree: `src/cloud/renewal.ts`, `src/listener/runtime.ts`, `src/cli.ts`,
`src/cloud/delivery.ts` and `src/cloud/signals.ts`. I also read the deleted `tests/p1-cli/renewal-refusal-cause.test.ts`
at 4bd26f53 (the lead's addition). I ran three tsx probes from `/private/tmp/opus5-probe`. They imported the worktree
`src` by absolute path and used stub fetchers, a fake clock and an in-memory credential store. They made no network
call. I deleted the directory. The worktree is clean. This file is the only file I left.

## Round-4 findings: status at a48b1aca

| Round-4 finding | Status |
|---|---|
| Opus P1: renewal 401/403 stopped at once; a foreign 400/404 switched renewal off | FIXED as stated. A 401 `unauthenticated` is a window sample (`renewal.ts:442-446`). Other 4xx give `RenewalOutcomeUnknown`, and `unsupported` is gone. But see P1: the window and the token expiry interact badly. |
| Opus P2 / Grok 3: `426 upgrade_required` retried for ever | FIXED. `[426, "upgrade_required"]` is in `COMMAND_FATAL_ANSWERS`. Probe (supervisor, renewal 426): `state=failed code=upgrade_required`, and the rendered status gives the installer and npm commands. |
| Opus P3 / Grok 4: ACK session codes had no action | FIXED (`cli.ts` `ack_retry` branch with `DELIVERY_SESSION_PROOF_CODES`, test for all four codes). |
| Opus R1: read 405 was fatal | FIXED (removed from `READ_FATAL_ANSWERS`). |
| Grok 1: malformed pending count on claim stopped the listener | FIXED (`DeliveryMalformedResponseError`, retried). |
| Grok 2: full page with a malformed last row stopped the listener | FIXED. The check moved into the read handler as `SignalMalformedError` (`runtime.ts:1448-1452`). |
| Grok 5: the fatal-pair test could not catch a missing member | FIXED. The test now compares against its own list. |
| Grok 7: the failed credential state dropped the code names | FIXED (`credentialCheckEdge` kept on a credential stop). |

Parser class: a mutation fuzz of the claim, read-page and renewal parsers (1104 single-field mutations over valid
bodies, 892 of them raised errors) found no error outside `DeliveryMalformedResponseError`, `DeliveryResponseError`,
`SignalMalformedError` or `RenewalOutcomeUnknown`. A positive control (a bad local command id) was reported as
untagged, so the detector can fail. The parser claim holds for the shapes I tried.

## P1: PRODUCTION. One renewal 401 in the last five minutes before expiry becomes a permanent stop, because the window sleeps past the expiry

`holdCredentialWindow` always sleeps `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` (5 minutes, `runtime.ts:146`, `:1280`) after
a confirmed sample. A 1-hour token is renewed only 6 minutes before it expires (`renewal.ts:121-143`: 10% of the
lifetime, floor 5 min). When a renewal gets a foreign `401 {"error":"unauthenticated"}` with less than 5 minutes
left, the listener makes no further renewal attempt until after the token has expired. Our edge then refuses the
expired token with the same 401, and those answers complete the window:

```ts
// runtime.ts:1277-1281
    emitCredentialCheck();
    await sleep(CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS, abort);
```

Probe (runtime with the real `AgentCredentialSession`, `listenerMode: true`, token expiry E, fake clock). The renewal
gets network errors from E-6m to E-5m, then one foreign 401. After that it gets our backend, which renews a live
token and refuses an expired one with 401:

```
-5.01m renew#9  -> network      read_retry renewal_retry
-4.53m renew#10 -> 401          credential_check unauthenticated checks=1
 0.47m renew#11 -> 401          credential_check checks=2     (token expired at 0.00m)
 5.47m renew#12 -> 401
stop=credential error=RenewalCredentialCheckError at 5.47m
```

Control, same run, with a foreign HTML 404 in place of the single 401: `-4.85m renew#9 -> 404`, `-4.38m renew#10 ->
200`, `read_recovered`, and no stop. The backend was reachable 30 seconds after the foreign answer. In the 401 case
the listener did not try again for 5 minutes, and that wait used up the token's remaining life.

This is the 2026-09-16 incident class: a DNS switch to a backend that does not know the token. Tolerance near
renewal is 5 minutes at most (a 5-minute foreign switch that starts at the due time survives with about 1 minute
left). It falls towards zero when transport errors come before the first foreign 401, which is the usual shape of a
DNS change. Elsewhere in the hour the tolerance is about 10 minutes. While this happens, status says "It will stop
at <E+5.5m> if every check until then confirms the loss". It does not say that the token expires at E, before the
next check, so the outcome is already decided.

The fold-7 test `renewal 401 unauthenticated opens the listener credential window` (`tests/listener-runtime.test.ts:6242`)
sets up this exact case (token 3 minutes from expiry, `:6237`) and aborts on the first 5-minute sleep. So it never
observes the result.

Fix: while a window is open and the session has a known expiry, make the next check no later than the expiry minus
a margin, or use the renewal backoff (at most 30 s) until then. A renewal 401 while the predecessor is still live can
count as a sample without adding a 5-minute sleep. Add a runtime test that continues past the first sleep and
recovers when the backend comes back before expiry.

## P2: PRODUCTION. Fold 7 removed the D-004 and D-011 behaviour for one-shot commands and deleted the tests that pinned it (lead addition)

Fold 7 deleted `LOCALLY_EXPIRED_MESSAGE` and `UNEXPLAINED_REFUSAL_MESSAGE` from `renewal.ts`. It rewrote the 401/403
branch (`renewal.ts:442-446`) and replaced the 13 tests in `tests/p1-cli/renewal-refusal-cause.test.ts` with 6 tests.
None of the 6 checks operator text. Probe, `AgentCredentialSession.bearer()` with `listenerMode` unset (the one-shot
path). "CLI prints" follows `cli.ts:9757-9764`: only `RenewalReauthorisationRequired`, `RenewalRevoked` and
`RenewalSuspended` get their paragraph, and every other error prints as `cswarm: <message>`.

| Deleted test (4bd26f53) | Input | a48b1aca result | Verdict |
|---|---|---|---|
| D-004: past its own expiry reported as expired | expired, 401 `forbidden` | `RenewalOutcomeUnknown`; prints `cswarm: renewal command answered HTTP 401` | LOST |
| (same class, the answer our edge sends) | expired, 401 `unauthenticated` | `RenewalCredentialCheckError`; prints `cswarm: renewal command refused the credential (unauthenticated)` | LOST: no expiry sentence, no remedy |
| D-004: expiry message does not deny a revocation | expired | message gone | LOST |
| named revocation outranks local expiry (401 with `reason`) | expired, 401 `reason: renewal_lineage_revoked` | `cswarm: renewal command answered HTTP 401`; `reason` ignored | CHANGED (our edge sends no reason at 401 today, so this is low reach) |
| D-011: live credential refused at 401 names neither cause | live, 401 `forbidden` | warning, and the command goes ahead | CHANGED from fatal to proceed |
| (same, the answer our edge sends) | live, 401 `unauthenticated` | `cswarm: renewal command refused the credential (unauthenticated)` | LOST: still fatal, but the remedy ("Ask whoever runs this workspace for a new credential, and whether this agent's access was changed") is gone |
| D-011: null expiry names neither cause | n/a (null expiry never renews) | the message it pinned no longer exists | LOST |
| D-011: unexplained refusal gives a remedy | any 401/403 | no remedy in any 401/403 message | LOST |
| server-named revocation at HTTP 200 | 200 `rejected renewal_lineage_revoked` | `RenewalRevoked`, `REVOKED_MESSAGE`, printed as a paragraph | HOLDS, but no test pins the text now |
| server-named expiry at HTTP 200 | 200 `rejected predecessor_expired` | `RenewalRevoked`, "expired before it could renew itself" | HOLDS, text not pinned |
| 403 treated exactly as 401 | expired 403 | `cswarm: renewal command answered HTTP 403`; a live 403 goes ahead with a warning | CHANGED |
| D-004 / D-011 reach production through `bearer()` | as above | as above | LOST |
| class: asserts no cause it did not measure | 401/403 | holds trivially (no cause named), but the measured-expiry branch is gone | WEAKENED |
| prose pins (3) | n/a | two pinned strings deleted; `REVOKED_MESSAGE` has no pin | LOST |

LANE.md Fold 7 says only "one-shot CLI commands may use a still-live predecessor". It does not report that the
operator text for an expired or refused credential changed, and it does not report that 403 became non-fatal for
one-shot commands. The deleted header comments in `renewal.ts` were the design record for D-004/D-011. This is an
unannounced change to operator-facing wording and behaviour outside the listener. The next step an operator used to
read ("Ask whoever set this agent up for a new one") is now a bare code.

Related wording, same fold: `RenewalUpgradeRequiredError` (`renewal.ts:248`) says "Update cswarm, then restart the
listener", and a one-shot command prints this too (probe: `cswarm: This copy of cswarm is older ... then restart the
listener.`). `cswarm inbox --follow` passes a credential predicate that lists `RenewalRevoked` but not
`RenewalCredentialCheckError` (`cli.ts:4950-4954`). A renewal 401 there no longer ends as a `credential` stop. I did
not trace which stop it reaches.

Fix: keep the listener's classification. For one-shot callers, map `RenewalCredentialCheckError` (and an unknown
outcome on an expired token) back to a `RenewalRevoked` with the measured cause: `predecessor_expired_local` with
the expiry sentence when `now >= expiresAt`, otherwise the unexplained-refusal sentence. Restore the prose pins and the
`bearer()` tests for the one-shot path. Make the 426 sentence depend on the caller, and add
`RenewalCredentialCheckError` to the follow predicate. Record the 403 decision in LANE.md.

## R1: RIGOUR. A renewal outage longer than the remaining lead ends the listener, and status does not say so ahead of time

Probe: network errors from E-6m to E+1m, then our backend. The renewal retried 23 times at the capped backoff. At
E+0.3m, `bearer()` threw `RenewalRevoked("predecessor_expired_local")`, which is a local credential stop and is not
restartable. That is correct, because an expired token cannot be renewed, and LANE.md discloses it. But the
`renewal_retry` sentence (`cli.ts:5721`) says only "leave it running and check the command edge if renewal does not
recover". It does not say that the listener stops for good at the stated expiry and then needs a new credential
(AGENTS.md "Honesty is not sufficient"). Also, in listener mode a failed renewal now stops reads and claims while the
token is still valid (`renewal.ts` `bearer()`: `RenewalRetryError` instead of returning the live token). So a
command-edge-only outage pauses signal reads for up to 6 minutes before the stop.

## R2: RIGOUR. Response-content stops outside the parsers are still plain `Error` and fatal

The parser class is closed, but the runtime still validates response content after parsing and stops with a plain
`Error` that is not restartable. The AST test does not look at these checks (its roots are in `signals.ts`,
`delivery.ts` and `renewal.ts` only):

- `runtime.ts:1920` "delivery lease deadline is invalid": the lease ends more than 15 min + 60 s after the local
  clock. A server clock or a different edge with a longer lease stops the listener for good. A test pins this as
  intended.
- `runtime.ts:1879` / `:1927` "delivery claim replay did not return / does not match the stored lease": a claim
  replay answered by a backend that does not hold the command (for example a restored copy that accepts the token)
  stops the listener for good.

Reach depends on a foreign backend that accepts the credential. The 2026-09-16 backend did know the agent (read 403
`forbidden` is `is_revoked`), so I cannot rule this out. The Fold 7 text "closes the response-parser class" is true
for parsers only and should say so.

## R3: RIGOUR. Limits of the AST test

The walker flags only `throw new Error` (and `DeliveryProtocolError` in `delivery.ts`) inside same-file
`FunctionDeclaration`s. It does not see a factory that builds an untagged error and returns it for the caller to
throw. For example, if `plainMalformedError` (`signals.ts:267`) went back to `new Error(message)`, the test would
pass, because the `new` is not in a `throw` statement. It also does not see arrow functions, methods, cross-file
helpers, or implicit `TypeError`/`RangeError`. My fuzz did not find an instance, so this is a gap in the proof. It is
not a defect I observed.

## Checked and correct

- Stop enumeration (`reason: "fatal"|"credential"` in `runtime.ts`): `credential` comes only from
  `isLocalCredentialLoss` (renewal horizon, `RenewalRevoked` including `predecessor_expired_local`, missing secret) or
  a complete window. `fatal` comes from an exact fatal pair, H0, configuration, local journal/effect errors, and the
  R2 sites. `RenewalRetryError` and the tagged malformed classes retry in process and are restartable
  (`runtime.ts:538-541`, `:659-662`).
- Fatal sets: read `400 invalid_request`, `404 channel_not_found`. Command `400 invalid_request`, `403
  h0_seat_uses_poll`, `409 command_id_conflict|delivery_ack_conflict|delivery_not_surfaced`, `413 payload_too_large`,
  `426 upgrade_required`. Each is a deterministic answer from our edge to the same request. My round-4 R2 (version
  skew on `invalid_request`) still applies as a limit.
- Renewal cannot loop hot. The probe shows backoff from about 0.5 s up to the 30 s cap (23 attempts in 7 minutes). A
  foreign answer keeps `pending` for replay and does not disable renewal. The credential window samples once per
  5 minutes.
- `renewal_retry` status names the expiry and next attempt. Supervisor transitions clear `renewalExpiresAt` and
  `nextAttemptAt` on ready, recovery, stop and failure.
- All changed test files run under `npm test` (three listener files are named in the literal list) or the
  `test:p1-cli` glob.

## Not established

I did not run the package gates or start a listener. My P1 backend is a stub that renews a live token and refuses an
expired one with 401 `unauthenticated`. I did not confirm from the edge source that an expired predecessor gets
exactly that answer (`command/index.ts:8903-8915` gives 401 `unauthenticated` when `authenticateAgent` fails). I did
not measure how many production listeners use 1-hour tokens, or how DNS changes on the box actually look to a client.
The "CLI prints" column copies the `cli.ts` catch logic. I did not run the CLI binary.

VERDICT: FAIL
