# D-036 Checker (Claude Opus), round 10: lane/listener-outage @ 0a47a550

Base a9846955. I read brief10, opus-r9.md, LANE.md "Fold 13", and `git diff 10b6201e...0a47a550` (source, tests and evidence). I also read the fold-13 call sites at 0a47a550 in the detached worktree: the read path, the claim path, the ACK path, `holdCredentialWindow`, the wait helpers, the supervisor `wake` and `idle_poll` handlers, the status renderer and JSON, and the turn budget. `git status --short` in the worktree was empty before and after.

Probes. I used `/private/tmp/opus10-probe`, with a `git archive 0a47a550` copy, a `git archive a9846955 src` copy and one mutant copy. They used stub fetchers, a wake stub, a fake clock and a temporary state directory. They made no network call and started no listener or child process. I deleted the directory afterwards. In the head copy I ran the files that start no process: `listener-runtime`, `listener-wake` and `idle-poll`. Result: 147/147 pass, exit 0. I did not run `listener-control`, `listener-cli-process` or `p1-cli/listener-provider`, because those files spawn processes. No process of mine is left, and no fixture listener is running on the host (`ps` shows no `__listen-supervisor`).

## Round-9 findings: status at 0a47a550

| Round-9 finding | Status |
|---|---|
| P1: a busy push listener got a false throughput LAPSE and "reconcile every 15s" | FIXED. `supervisor.ts:529-531` scores push hours at `LISTENER_RECONCILE_POLL_MS` again. Measured with the real supervisor and the round-9 feed (push, one delivery every 4 min, `idle_poll` 15000 after each): hour 10:00 had 15/12 claims, no LAPSE, and the line said "reconcile every 5m". Positive control: a push feed with one claim every 20 min gave 3/12 and printed the LAPSE. The `idle_poll` cadence change (`supervisor.ts:577-581`) adds no behaviour: a mutant without it gave the same results, because every claim hour also has a `wake` event at 300 s. It is harmless. |
| P2: `nextAttemptAt` left out the wake or idle wait after a read-path retry | FIXED. `forceRead = true` after the transient backoff (`runtime.ts:1651`), after a confirmed read-path answer (`:1605`) and after a transient answer in the window (`:1620`). The next iteration skips the wake wait (`:1482`), so the backoff or the credential-check sleep is the only wait. The new tests pass: "read retry time is the next read…" and "renewal retry time is the next renewal…" (poll and push, 500 and 401). Mutation: I removed `forceRead` at `:1651` in a copy, and the read test failed (`actual: 2` wake waits, exit 1). |
| P3: a worker turn could move the first renewal to expiry - 60 s | FIXED. `TURN_BUDGET_CREDENTIAL_MARGIN_MS = RENEWAL_WINDOW_EXPIRY_MARGIN_MS` (`cli.ts:3333`). The clamp (`:3353`) and the defer check (`:3384`) use it. The import comes from `runtime.ts:156`, and no module imports `cli.ts`, so there is no import cycle and no undefined value at load. A turn now ends by the renewal deadline, so the ACK's `bearer()` starts renewal there. |
| R1: unknown-expiry `claim_retry` said 30 s | FIXED. `runtime.ts:1911-1914` uses the same choice as `holdCredentialWindow` (`expiry == null` gives 300 s, otherwise 30 s, both through `capWaitMs`). `sleep` caps with the same `now`, so the event, `credential_check.nextAttemptAt` and the sleep agree. |
| R2: fixture listener leaked; stop errors swallowed | FIXED in the tests. `stopAndWaitForDetachedListener` (`tests/listener-cli-process.test.ts:124-155`) asserts exit 0 when the listener was alive. If the stop does not end the process, it sends TERM and then KILL, and then it throws. The three `finally` blocks no longer catch that error. PID 41726 is gone. The committed `fold13-detached-credential-check-status.json` has no token (`swm_agt_` count 0). It shows `credentialStopAt` = start + 10 min and `nextAttemptAt` = +30 s, which matches the known-expiry rule. |
| R3: tests could not see P1/P2 | FIXED. See the P1 and P2 rows. |

## PRODUCTION

None found.

## RIGOUR

**R1. After a wake-driven empty claim, the push line says "reconcile every <time left until the next reconcile>". This is a wording gap left by folds 12-13.** `runtime.ts:2010` sets `pushReconcileWait` on every empty claim in push mode. That includes a wake claim (`skipRead`), which does not move `reconcileDueAt`: only a claim after a read does that (`:1963`). So `intervalMs = wakeWaitUntil() - now` is the rest of the current 5-minute period. `supervisor.ts:575` stores it, `cli.ts:5913` passes it, and `wake.ts:213` prints "reconcile every X". Measured with the real runtime and supervisor, push mode, wake stub. First a reconcile claim, then one wake returns later, and its claim is empty:

```
wake after 60s:  idle_poll 300000 push=true; idle_poll 240000 push=true -> "push (Realtime), …, reconcile every 4m."
wake after 280s: idle_poll 300000 push=true; idle_poll 20000  push=true -> "push (Realtime), …, reconcile every 20s."
base a9846955, same feed: "reconcile every 5m." in both cases
```

The number is the true next planned wait. LANE fold 13 defines the field that way ("the next planned push reconcile wait"). Round 9 accepted the same semantics for the renewal-capped wait. But "every" reads as a period, and the period is still 5 minutes. No LAPSE, stop or retry decision reads this field, so nothing but the sentence is affected. I class it RIGOUR for that reason. Fix (one line): set the flag only for a reconcile claim, `pushReconcileWait: snap.mode === LISTENER_WAKE_MODE_PUSH && !skipRead`. Or change the push wording to "next reconcile in X". The field can also be stale after a poll-to-push flip: it keeps the last push value until the next empty push claim. The same fix limits the effect.

**R2. The turn clamp trades turn length for renewal timing.** A turn that starts in the 10 minutes before renewal is due now gets up to 50 s less budget than at 10b6201e (for example, a start at expiry - 400 s gets 290 s, not 340 s). A turn that needs that time times out and is redelivered. This can happen at most once per credential period, because the redelivered turn renews first. This is the fix that round 9 asked for, and it is correct for invariant A. LANE does not state the cost. An alternative with no cost is to renew at turn start when the turn would cross the due time.

**R3. Single-answer permanent stops (unchanged since round 9, listed as the brief asks).** These are: a recognised 426 `upgrade_required`; the first failed renewal answer after local expiry; `h0_seat_uses_poll` (with its own code and sentence); named local losses; and local journal or protocol faults. Fold 13 adds no stop path. Its source diff has no `stop =`, no `reason:` and no restart-classifier line, and no `.message` read (D-053).

## Checked and correct

- **Invariant A.** Fold 13 only removes waits (`forceRead`) and shortens turns. Every remaining sleep goes through `sleep` → `capWaitMs` (`runtime.ts:995-1009`), which includes `holdCredentialWindow`. The renewal test covers push and poll with a wake subscriber at due - 60 s. The next renewal comes at the stated time.
- **Invariant B.** Fold 13 does not change `src/cloud/` (the diff touches only `cli.ts`, `listener/control.ts`, `listener/runtime.ts` and `listener/supervisor.ts`). The `cli.ts` changes are the listener turn budget and the status render. So the round-9 one-shot measurement (160/160 identical to a9846955, with a positive control that differed in 100/160) still applies. I did not rerun it.
- **Invariant C and request rate.** After a forced read, the backoff sleep advances `waitGeneration`, so `paceRequest` still gives at least 1 s between requests. When renewal is due, the read after the renewal POST waits the 1 s floor. The read backoff is `nextFollowBackoffMs`, capped at 30 s (`SIGNAL_FOLLOW_BACKOFF_MAX_MS`), which is inside the 5-minute cap. The steady outage rate does not change from base: at a9846955 the wake wait before a retry returned at once when `reconcileDueAt` had passed. Status writes follow events, so they are at most one per request.
- **Stop in any wait.** It is unchanged. Every new `forceRead`/`continue` goes back to the loop top, and the loop top checks `abort` first.
- **Lapse and status.** Push hours score at 300 s. Poll hours still use `idlePollMs`, as at base. `pushReconcileWaitMs` is in `STATUS_ALLOWED_KEYS` and in the parser (`control.ts:331`, `:665-668`, `:753-755`). An older status file without the field falls back to 5 m. `listenerStatusJson` spreads the status, so the JSON shows the field.
- **Tests.** Every changed test file is in the literal `npm test` list (`listener-runtime`, `listener-control`, `listener-cli-process`, `listener-wake`), or under the `test:p1-cli` glob (`listener-provider`, `citation-drift`). The new tests compare an event's stated time with the observed request time, or the lapse result with a count. They do not compare an artifact with its own generator.

## Not established

- I did not run `listener-control.test.ts`, `listener-cli-process.test.ts` or `p1-cli/listener-provider.test.ts`, because they spawn processes. I read the fold-13 tests in them and reproduced the push-cadence test with my own probe.
- I did not run the full `npm test`, `test:p1-cli` or `build-release.sh`. LANE records `build-release.sh` exit 0 and red full suites only where its sandbox denies `ps`.
- I did not rerun the invariant-B one-shot probe. I rely on the unchanged `src/cloud/` and the round-9 result.
- Times come from a fake clock and stubs. I did not measure how often production produces an empty wake claim (R1) or how long turns are near the due time (R2).

VERDICT: PASS
