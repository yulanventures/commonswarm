I'll review this lane read-only: the record first, then the Fold 8 diff against both the base and the Round 5 commit, with no file changes and no listener.Fold 8 is the commit under review. I'll compare the restored refusal tests with `a9846955` and then walk the near-expiry renewal path in the source.The restored refusal file matches the base blob. Next I’ll run a stubbed clock through the near-expiry orderings, including a confirmed renewal 401 followed by a network error.Round 6 fails. A recognized renewal 401 still opens the short retry, but the next transient inside that window waits five minutes and can expire the token. One-shot commands also fail closed on two refusals that `a9846955` used to ride out while the token was still live.

The refusal file is unchanged from the base. `tests/p1-cli/renewal-refusal-cause.test.ts` at `402c7a71` is blob `298e079dec21ed2431e1fca01bcfcff3f7619447`, the same blob as `a9846955`. All 15 tests are there: 12 `test()` calls plus the three prose pins generated at line 406. Their D-004 and D-011 wording is the base wording. A stub-fetcher probe with a fake clock, and no network, showed a live one-shot foreign 401 still throws `RenewalRevoked` `"forbidden"` with "does not say why".

## PRODUCTION

**1. A transient after a renewal 401 sleeps five minutes and can end the listener before expiry.** `src/listener/runtime.ts:1289-1298`

The short schedule runs only when the current error is `RenewalCredentialCheckError`. Any other sample in that window, including `RenewalRetryError`, waits `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` (five minutes):

```1289:1298:src/listener/runtime.ts
    const beforeExpiry = error instanceof RenewalCredentialCheckError &&
      expiry !== null && expiry !== undefined &&
      expiry - atMs > RENEWAL_WINDOW_EXPIRY_MARGIN_MS;
    const delayMs = beforeExpiry
      ? Math.min(
          RENEWAL_WINDOW_RETRY_MS,
          expiry - atMs - RENEWAL_WINDOW_EXPIRY_MARGIN_MS,
        )
      : CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS;
    await sleep(delayMs, abort);
```

The read, claim, and acknowledgement catches all send that transient into `holdCredentialWindow` (`src/listener/runtime.ts:1530-1531`, `:1827-1828`, `:1379-1380`). Renewal for a one-hour token only runs in the last six minutes (`RENEWAL_LEAD_FLOOR_MS` is five minutes; 10% of one hour is six). One network error or HTTP 500 after the 401 uses up the rest of that life.

Probe, token with four minutes left, stub fetcher, fake clock:

| Step | Remaining | Answer | Sleep |
|---|---:|---|---:|
| 1 | 240s | 401 `unauthenticated` | 30s |
| 2 | 210s | network error | 300s |
| 3 | −90s | still down | — |

Stop was `credential`, `RenewalRevoked` code `predecessor_expired_local` ("The current credential expired while renewal was unavailable"), `isRestartableListenerStop` false. The same shape with HTTP 500 on step 2 slept `[30000, 300000, 300000]`, made no read, and then the expired token's 401s finished the ten-minute window. A successor offered any time after step 2 and before expiry was never requested.

Controls on the same harness did recover: two 401s then a successor (sleeps 30s, 30s, 15s); network-only and a foreign HTML 401 (sleeps 0.5s, 1s, then a read). Those orderings match Fold 8. The ordering the round-5 failure left open, a confirmed 401 and then a transient, does not.

While that five-minute sleep runs, status stays `credential_check` with `nextAttemptAt: null` (`src/listener/supervisor.ts:663-670`). The sentence at `src/cli.ts:5714` names `credentialStopAt`, about ten minutes out, and says the listener stops then if every check confirms the loss. The expiry sentence at `src/cli.ts:5718-5719` is selected only for `lastErrorCode === "renewal_retry"`, and this path keeps the code `unauthenticated`. The stop in the probe was at 5.5 minutes, on local expiry, with no restart.

**2. One-shot commands now fail on a live token for `renewal_unsupported` and a device refusal.** `src/cloud/renewal.ts:856-862`

```856:862:src/cloud/renewal.ts
      if (error instanceof RenewalCredentialCheckError ||
          error instanceof RenewalUpgradeRequiredError ||
          error instanceof RenewalReauthorisationRequired ||
          error instanceof RenewalSuspended ||
          error instanceof RenewalRevoked ||
          error instanceof RenewalUnsupported ||
          error instanceof RenewalRefused) throw error;
```

At `a9846955` `bearer()` (`src/cloud/renewal.ts:884-901` there) threw `RenewalRevoked` always, and reauthorisation or suspension always. A live `RenewalUnsupported` warned, set `unsupported`, and returned the token (`due()` then stayed false). A live `RenewalRefused`, including a device mismatch, warned and returned the token. Fold 8 names those two as fatal in listener mode. It does not name them as fatal for one-shot commands. The 426 sentence change is named, and the probe's one-shot 426 throws `RenewalUpgradeRequiredError` with "run the command again".

Probe, listener mode off, three minutes of life left: `200 rejected renewal_unsupported` threw `RenewalUnsupported`; `renewal_device_mismatch` threw `RenewalRefused`. Neither returned the token. `inbox --follow` opens the session without listener mode (`src/cli.ts:3198`, default at `:3105`). Those errors are not credential failures (`src/cli.ts:9841-9846`) and are not retryable follow errors, so the follow loop stops with `reason: "error"` (`src/cloud/signals.ts:2807-2810`). The restored refusal tests never send these reasons through one-shot `bearer()`. `tests/p1-cli/renewal-listener-samples.test.ts:105-117` asserts the fatal class only with `listenerMode: true`.

## RIGOUR

**1. The new near-expiry tests never combine a confirmed 401 with a later transient.** `tests/listener-runtime.test.ts:6312-6352` feeds two 401s and a successor, and only checks that each sleep is at most 30 seconds. `:6354-6373` feeds only 401s. The detached eight-second token (`tests/listener-cli-process.test.ts:2190-2238`) accepts a successor on the second answer. Replacing `RENEWAL_WINDOW_RETRY_MS` with five minutes would fail the first test. Leaving the transient branch on `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` would not.

**2. The last confirmed sample at the five-second margin waits five minutes.** `src/listener/runtime.ts:1290-1292` requires `expiry - atMs > RENEWAL_WINDOW_EXPIRY_MARGIN_MS`. A 20-second token's first 401 slept 15 seconds; the next 401, with 5 seconds left, slept 300 seconds. The comment at `:147` says a renewal check must leave more than one attempt before expiry. A pure 401 run still stops only after the ten-minute window (the probe stopped at 615 seconds). A recovery in those last five seconds is not attempted. `RENEW_TIMEOUT_MS` is 30 seconds, so this gap is small next to finding 1.

**3. One-shot HTTP 400/404 no longer latches off renewal.** At `a9846955`, 400 and 404 threw `RenewalUnsupported` (`:467` there) and `due()` stopped asking (`:840` there). Head `requestSuccessor` turns every other non-OK status into `RenewalOutcomeUnknown` (`src/cloud/renewal.ts:475-476`). The probe's live one-shot 400 returned the token and warned "renewal command answered HTTP 400". The command still proceeds. The old "does not offer credential renewal yet" sentence is gone, and every later command inside the lead warns again because the pending id is kept for an unknown outcome (`src/cloud/renewal.ts:942-948`).

**4. A foreign lease answer is tagged and still fatal.** `src/listener/runtime.ts:1894-1899` and `:1934-1947` throw `ListenerLeaseResponseError` and stop with `reason: "fatal"`. `isRestartableRuntimeError` does not treat that class as retryable. The tests at `tests/listener-runtime.test.ts:6206-6240` require that stop. A backend that accepts the credential and returns a longer lease, or a replay that drops the stored lease, still ends the listener on that one answer. This is the round-5 lease finding with a tag added.

## Checked

Read-edge `403 forbidden` is only `agent.is_revoked` (`supabase/functions/read/index.ts:474-475`). Command-edge `forbidden` is not a confirmed code (`src/cloud/signals.ts:2373-2376`). `cswarm listen stop` aborts `defaultSleep` and the timer is cleared (`src/listener/runtime.ts:799-809`). `parseSignalAttachments` throws `SignalAttachmentMalformedError` (`src/cloud/attachments.ts:29-31`), classified as `malformed_response`. The parser walker registers methods, arrows, and function expressions and follows `./` imports, including attachments (`tests/listener-runtime.test.ts:123-144`). The acknowledgement scenarios send every `DELIVERY_SESSION_PROOF_CODES` member (`tests/listener-runtime.test.ts:4025-4028`). Listener-mode `renewal_unsupported` and device refusals throw their own classes. `renewal_retry` copy says the listener stops at expiry if renewal does not succeed (`src/cli.ts:5718-5719`); that state is what a foreign 404 uses. Follow still stops on one confirmed read code. The reported stops were listeners. New tests sit in `tests/listener-runtime.test.ts` and `tests/listener-cli-process.test.ts` (both named by `npm test`) or under `tests/p1-cli/**/*.test.ts` (`npm run test:p1-cli`). The p1-cli count in Fold 8 (838 = fold 7's 818, plus the nine restored refusal tests, plus the eleven new sample tests) matches the files. Renewal retries at 30 seconds are about two requests a minute per listener. No production host was contacted. No listener process was started.

VERDICT: FAIL
