# D-036 Checker (Claude Opus), round 2: lane/listener-outage @ 08c27a3c

Base a9846955. I read LANE.md (Folds 1-3), `git diff 93bbd6cd...08c27a3c`, and the changed code at 08c27a3c in
`src/listener/runtime.ts`, `src/listener/supervisor.ts`, `src/listener/control.ts`, `src/cloud/signals.ts`,
`src/cloud/delivery.ts` and `src/cli.ts`. I also checked the `delivery_unavailable` producers in
`supabase/functions/command/index.ts`. I ran two things. (1) `tests/listener-runtime.test.ts` in the detached worktree
with a temporary HOME: 83 tests, 83 passed, exit 0, worktree still clean. (2) One tsx probe from a temporary folder
under /private/tmp. It reused the test file's fixtures, imported the worktree `src` by absolute path, used stub
`fetcher`/`readPage`/`deliveryClient` and a fake clock, and made no network call. I deleted the folder. This file is
the only file I left.

## Round-1 findings: status at 08c27a3c

| Round-1 finding | Status |
|---|---|
| Opus F1: the real `readAgentSignalPage` error skipped the window | FIXED. `runtime.ts:537` returns false when `followHttpDetails(error) !== null`. The plain-error branch at `:563` now decides. The new stub-fetcher test drives the real path. |
| Opus F2 / Codex 1: a claim-only 403 looped with no read | FIXED for the revoked case: after 3 refusals `forceRead` sends the listener back to a read (`:1690-1703`, `:1714`). But see N1: the fix brings in a new defect. |
| Codex 2: `nextAttemptAt` stayed set after the wait | FIXED: `supervisor.ts:1022` `transition("starting", { nextAttemptAt: null })`. |
| Codex 3: the check sentence over-promised | FIXED: `cli.ts:5705`. |
| Codex 4: D-053 `/secret is absent/` | FIXED: `signals.ts:2469` uses `LocalCredentialSecretAbsentError`. See R2 for the new classification. |
| Opus F3: attendance used the caller's cwd | FIXED: `projectDirectory` is recorded (`cli.ts:6693`, must be absolute: `cli.ts:7155`, `control.ts:651`) and is used at `cli.ts:7273`. |
| Opus F4: start paths did not list `credential_check` | FIXED. The lists are still typed by hand in each place (R1). |
| Opus F5: code list came from the wrong edge | FIXED: `credentialCheckEdge` selects the constant. |
| Opus F6: foreign 400/404/426/HTML/capabilities were fatal | These now retry. But see N2. |
| Opus F7: `inbox --follow` still stops on one code | Unchanged, and LANE.md discloses it. Not a blocker for the reported listener incidents. |
| Opus F8: the H0 sentence gave no next step | Changed. See R3. |

## N1: PRODUCTION. The forced read resets the claim back-off. A command-edge failure while reads succeed makes a hot loop that never ends (about 4 requests every 1.5 s or less).

`runtime.ts:1632-1633` sets `let deliveryAttempt = 0` again every time the durable-claim block is entered. The new
exit at `:1700-1703` leaves that block after 3 refusals and does not sleep:

```ts
if (claimRefusals >= LISTENER_CLAIM_REFUSALS_BEFORE_READ) {
  forceRead = true;
  break;
}
deliveryAttempt += 1;
const delayMs = deliveryRetryDelay(deliveryAttempt, error, random);
```

The forced read runs at once (`:1289` skips the wake wait, and there is no idle sleep before the claim). When that read
succeeds, `:1343-1346` sets `claimRefusals = 0` and emits `claim_retry_cleared`, and the claim block starts again at
`deliveryAttempt = 0`. So the claim back-off never goes above attempt 2. `deliveryRetryDelay(1)` is 0 to 500 ms and
`deliveryRetryDelay(2)` is 0 to 1000 ms. The 30 s cap (`LISTENER_DELIVERY_RETRY_MAX_MS`) is never reached. At 93bbd6cd
the same loop grew to that cap.

Probe (stub read that always succeeds with `durablePage([], 1)`, claim that always throws `DeliveryHttpError`,
`random = () => 1` to get the largest jitter, fake clock):

```
command-edge 503           reads 9 claims 24 elapsed_s 12 max_sleep_ms 1000 sleeps [500,1000,500,1000,...]
                           events {"ready":1,"claim_retry":24,"claim_retry_cleared":8}
command-edge 403 forbidden reads 9 claims 24 elapsed_s 12 max_sleep_ms 1000 (same pattern)
```

The test wrapper stopped the run after 8 reads. Nothing in the runtime would stop it. With normal jitter the mean
cycle is about 0.75 s. That is roughly 5 requests per second per listener for the life of the process. It is the
opposite of "backoff capped at 5 minutes". It happens in a realistic partial outage: the database refuses writes (disk
full, read-only fail-over) or the command edge fails while the read edge works. It also happens with any lasting
command-edge answer that is not a credential code, for example `403 forbidden` (the lane rules that this is not a
credential check) or a `delivery_unavailable` from a condition other than revocation (`command/index.ts:9291`,
`:10200`, `:10262`, `:11088`: agent or ledger null). Across a fleet of about 20 listeners, this load lands on a server
that is already degraded. Every refusal also writes the status file and appends a `listener_claim_retry` log line
(`supervisor.ts:668-675`), which is about 3 writes a second. I found no size bound in `appendListenerEvent`
(`control.ts:758`).

Status is also false in this state. It flips between `claim_retry` ("refused 1 times" or "2 times") and `ready` every
cycle, so a `cswarm listen status` read in about half the cycle shows a healthy `Listener ready`, and the count never
shows how long the outage has lasted.

No test covers "claim fails, forced read succeeds". The only test (`tests/listener-runtime.test.ts`,
"claim-only delivery refusals force a read…") makes the second read fail, so the loop never closes.

Fix: keep the claim back-off across forced reads. Hoist `deliveryAttempt` out of the loop, or sleep
`deliveryRetryDelay(...)` before the forced read and reset only on a successful claim. Also add a test where reads
succeed and claims fail, and assert that the sleeps grow to the cap.

## N2: PRODUCTION. A misrouted or old read service at startup now stays in "starting" forever, gives no reason, and `listen start` exits 0.

Fold 2 makes 400, 404, 426, HTML-200 and the capability errors transient (`runtime.ts:505-513`, `:1400-1403`,
`:489-491`). Before the first successful read, `ready` is false, so the transient branch (`:1412-1435`) emits no
`read_retry` event. It only sleeps. The supervisor writes nothing. Also, `waitForListenerReady` now returns a live
`starting` status at timeout (`supervisor.ts:1251-1254`), and it no longer throws `ready_timeout`. `listen start` then
prints "Listener is still starting or checking; use cswarm listen status to follow it." and exits 0 (`cli.ts:7101-7103`).

Probe with the default read path (stub `fetcher`, fake clock), 40 requests:

```
startup 404 json   stop cancelled requests 40 elapsed_min 17.0 events []
startup HTML 200   stop cancelled requests 40 elapsed_min 17.0 events []
```

After 17 minutes there was not one event. `cswarm listen status` then shows `Listener starting for agent …` and
`CONNECTED: no. Transport state is starting.`, with no code, no cause and no next step. `listenerRetrySentence`
(`cli.ts:5708`) needs `nextAttemptAt`, and that field is not set here. This is the "LOCAL error that never heals" case
the brief asks about. A wrong target URL (for example the site host, which returns HTML or 404) or a self-hosted read
edge that is too old would never heal. At 93bbd6cd and at base, the first read failed fast with a named code. For the
capability codes, `cli.ts:6221-6225` still prints "update/deploy the read edge before starting a model", but that
branch can no longer be reached for these two codes. The start path has no network preflight that would catch the
misroute first (`runListenStart` makes no request before it spawns the process). This goes against AGENTS.md "Honesty
is not sufficient": exit 0 plus "still starting" hides the one fact the operator needs.

Fix: emit the retry event (code and next attempt) before `ready` too, and render it for `starting`. A retry does not
need to fail the start, but status must name the failure and the next step.

## R1: RIGOUR. The running-state lists are still typed by hand in six places

`cli.ts:5322-5323`, `cli.ts:6889-6893`, `cli.ts:7101`, `supervisor.ts:1116-1120`, `supervisor.ts:1190-1191` and
`control.ts:522`. This fold had to add `claim_retry` to each list by hand. The next state will drift in the same way.
One of them already drifts: `cli.ts:5906` treats every state other than `ready` as "It was measured before startup
failed". A listener in `claim_retry` or `credential_check` is running and did not fail at startup, so that provider
sentence is false in those states.

## R2: RIGOUR. `LocalCredentialSecretAbsentError` now covers a local state-file mismatch, and the next step it prints is wrong for that case

`cli.ts:6516-6517`: "listener credential state did not preserve the live credential" (the write-then-read check of the
listener's own state file) is now a credential stop. At base it was a fatal of a different kind. The stop sentence
(`cli.ts:5696`) says "Run cswarm whoami with this credential to see the grant state". For this cause, whoami will
report a healthy grant. The next step does not fit the cause. Also, two `bearer()` calls at the same moment during a
rotation can write different credentials between one call's write and its read, and that stops the listener for good.
I did not show that this race happens.

## R3: RIGOUR. The H0 sentence tells the reader to stop a listener that has already stopped

`delivery.ts:86`: "This seat receives messages through the h0 poll. Stop this listener; nothing else is needed for
this seat". It is printed only for `state: failed` (`cli.ts:5724`) or after a failed start (`cli.ts:6230`). At both
points the process has already exited. The sentence does not name a command. The code path itself is correct:
`isH0SeatClaimRefusal` runs before the other classifiers in both the claim and the ack paths, and
`isRestartableRuntimeError` returns false.

## R4: RIGOUR. Stale fields and claim wording

- The restart transition (`supervisor.ts:1004-1013`), the stopped transition and the failed transitions
  (`:1026-1036`, `:1043-1052`, `:1075-1087`) clear `credentialStopAt` but do not clear `credentialCheckEdge` or
  `claimRetryCount`. A stopped listener's JSON can still say `claimRetryCount: 2`. An edge from an earlier window can
  pick the code list for a later local credential stop.
- `cli.ts:5768`: "The last claim was refused (delivery_unreachable)". For a `DeliveryTransportError`
  (`runtime.ts:1679`), nothing was refused, because the server was not reached. "to check the credential" is also said
  for 5xx answers, which are not about the credential.
- `cli.ts:5322`: `CONNECTED: yes` during `credential_check`, when the server is refusing every read.

## Checked and correct

- Window arithmetic did not change from round 1. Every exit into the window now tags `edge`. Both command-typed errors
  map to `command`, and every other error maps to `read`.
- Forced read and delivery order: the forced read keeps the `claim_pending` journal record. A replay uses the same
  `claimCommandId` (`runtime.ts:1590-1613`, `:1622`), so no second claim is made. In durable mode the page rows are
  not delivered (the page loop at `:1940` is for the cursor path). The forced read then goes back to the claim. So
  there is no double read and no change in delivery order. Push wake: `!forceRead` at `:1289` skips the wake wait
  once, and `forceRead` is set back to false at `:1320`.
- Revoked seat: `403 delivery_unavailable` ×3 → forced read → read-edge `forbidden` → window → stop after 10 minutes or
  more and at least 3 checks. The test shows the first part.
- The foreign-response retries use the read back-off, capped at 30 s (`SIGNAL_FOLLOW_BACKOFF_MAX_MS`).
  `delivery_configuration_missing` stays fatal (`runtime.ts:490`, `:507`). All `plainMalformedError` producers
  (`signals.ts:1131, 1236, 1252`) come from responses, not from local state.
- The delivery error codes that reach `lastErrorCode` are allowlisted (`delivery.ts:695-707`), so `parseStatus`
  (`control.ts:532-534`) cannot reject them.
- All changed tests are in `npm test` (literal list) or in the `test:p1-cli` glob.

## Not established

I did not run the full gates. I did not run `listener-control.test.ts`. I did not start a live listener. I did not test
against a real command edge. I did not check whether a real deployment returns a lasting non-credential claim refusal
while reads succeed. N1 depends only on the client loop: the probe shows it with any such answer.

VERDICT: FAIL
