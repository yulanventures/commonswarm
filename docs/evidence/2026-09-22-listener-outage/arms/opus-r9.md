# D-036 Checker (Claude Opus), round 9: lane/listener-outage @ 10b6201e

Base a9846955. I read brief9, LANE.md in full (folds 1-12), opus-r8.md and grok-r8.md, `git diff e5cbb626...10b6201e` (source and tests), and the wait, renewal, supervisor, status and turn-budget code at 10b6201e in the detached worktree. `git status --short` in that worktree was empty before and after.

I ran tsx probes from `/private/tmp/opus9-probe`. They used stub fetchers, a fake clock that moves only by the stated stub latency (20 ms per request, 30 s per timeout) and by sleeps, and in-memory stores. They imported the worktree `src` and a `git archive a9846955 src` copy. They made no network call. I deleted the directory afterwards. I also ran the 8 fold-11/12 tests by name in the worktree with a temporary HOME (8/8 pass, exit 0). One of them, "detached listener records the next credential check attempt", starts a detached fixture listener on loopback with a temporary state directory and stops it. I did not start a listener in any other way. No process of mine is left.

## Round-8 finding: status at 10b6201e

| Round-8 finding | Status |
|---|---|
| P1: a push wake wait (300 s) or a sustained restart that starts before renewal is due is not capped, so the first renewal comes at about expiry - 60 s | FIXED for waits. `renewalWaitBoundary` returns `renewalAt` before due and the deadline after (`runtime.ts:984-992`). `capWaitMs`, `mayWaitForWake` and `wakeWaitUntil` use it (`runtime.ts:993-1001`, `:1252-1253`). The supervisor does the same (`supervisor.ts:1080-1088`). Measured below. The turn path is NOT covered. See P3. |
| 92 s margin: no room for the pending write; the sum lands on server expiry | FIXED. `RENEWAL_WINDOW_EXPIRY_MARGIN_MS` = 2x30 + 30 + 2x1 + 2x5 + 8 = 110 s, derived from `RENEW_TIMEOUT_MS` (`runtime.ts:152-159`). The 5 s write and 30 s clock allowances are assumptions. LANE says so. |
| Status reported 5 min while a due session waited to the deadline | FIXED for that case. But the fix makes two new false statements. See P1. |
| Null-store test allowed 1 read per second | FIXED. The test now requires the 15 s / 30 s / 60 s curve and exactly 3 reads in the margin. |
| Claim retry event said 300 s for a 30 s wait | FIXED for a known expiry. Not fixed for an unknown expiry. See R1. |
| 426 stops on one answer | Unchanged. LANE fold 9 names it as the version stop. |

## PRODUCTION

### P1. Fold 12 regression: a busy push listener now reports a false claim-throughput LAPSE, and says "reconcile every 15s"

`supervisor.ts:529-532` now uses `status.idlePollMs` as the push-mode claim cadence:

```ts
const cadenceMs = event.wake.mode === LISTENER_WAKE_MODE_PUSH
  ? (status.idlePollMs && status.idlePollMs > 0
    ? status.idlePollMs
    : LISTENER_RECONCILE_POLL_MS)
```

At a9846955 this was the constant `LISTENER_RECONCILE_POLL_MS`. But `idlePollMs` is not only the planned wake wait. After every claimed delivery, the runtime emits `idle_poll` with `intervalMs: pollMs` = 15 s (`runtime.ts:2013`), in push mode too. Each claim is preceded by `emitWake()`, and that wake event now records a 15 s cadence. An hour is scored at the slowest cadence recorded in it (`read-health.ts:233-237`). So in any clock hour where every claim returned a delivery, the hour is scored at 15 s: 240 expected claims.

The same 15 s reaches the push sentence. `cli.ts:5910-5915` passes `status.idlePollMs`, and `wake.ts:213` now prints it as the reconcile interval. The reconcile interval is still 300 s after a non-wake claim (`runtime.ts:1955`).

Measured. I drove the real `runListenerSupervisor` (head and the a9846955 archive) with the same event sequence: one empty reconcile, then from 09:59 one delivery every 4 minutes in push mode (wake, wake, `delivery_claim`, `idle_poll` 15000, as the runtime emits them). I rendered status at 11:00:30 with state `ready`:

```
HEAD: Listener LAPSE for agent …: listener_claim_throughput_lapse.
      push (Realtime), last wake 2m ago, reconcile every 15s.
      WARNING [listener_claim_throughput_lapse]: Claim throughput fell below 0.50 for the full hour at
      2026-09-01T10:00:00.000Z: 15/240 expected (0.063). Pending deliveries now: 3.
BASE: (no lapse line)
      push (Realtime), last wake 2m ago, reconcile every 5m.
```

Mutation control, in one copy of head: replacing only the push branch of `supervisor.ts:529-532` with `LISTENER_RECONCILE_POLL_MS` removed the lapse (`lapse false`). Unmodified head printed the lapse in the same run. So this line is the cause.

Who meets it: a push listener with a backlog for a whole clock hour. That is a busy seat, the one an operator is most likely to check. The LAPSE headline and its "Pending deliveries now: 3" read like a stuck listener, and the operator may restart a healthy one.

Fix: score push hours at `LISTENER_RECONCILE_POLL_MS` as before. For the human line, carry the planned wake wait in its own field (set only from the empty-claim `idle_poll` at `runtime.ts:1993-2003`) and fall back to 300 s. Do not reuse `idlePollMs`, which the delivery path also writes. Add a supervisor test with push mode, a delivery on every claim for a full hour, and a positive control.

### P2. `nextAttemptAt` and "will try again at …" leave out the wake or idle wait that comes after every read-path retry

After a transient read-path failure the runtime sleeps the backoff and does `continue` (`runtime.ts:1646-1647`). A confirmed credential answer on the read path does the same after `holdCredentialWindow` (`runtime.ts:1597-1603`). At the top of the loop the listener is `ready` and `forceRead` is false, so it enters the wake wait (`runtime.ts:1482-1492`). That wait lasts until `reconcileDueAt` (push) or the idle interval (poll). The status time comes only from the backoff: `nextAttemptAt = ts + delayMs` (`supervisor.ts:763`), or from `emitCredentialCheck(capWaitMs(delayMs))` (`runtime.ts:1367`). Nothing updates it when the wake wait starts. `nextAttemptAt` is new in this lane (a9846955 has none), so this is a lane claim.

Measured with the real `runListenerRuntime`, a real `AgentCredentialSession` where noted, and a wake stub that returns at `until`:

| Case | Status says next attempt | Next attempt |
|---|---:|---:|
| Poll mode, read edge 500 (no renewal) | +1.0 s | +31.0 s |
| Poll mode, renewal 500 at due time (1 h token) | +1.0 s | +61.0 s |
| Push mode, renewal 500 at due time, last reconcile 60 s before due | +1.0 s | +241.0 s |
| Push mode, renewal 401 at due time (credential check) | +30.0 s | +241.0 s |

Every read retry in the reported outage case (Realtime down, so poll mode, 500 or no response) shows a time that passes with no attempt. For the renewal case the sentence at `cli.ts:5725` says "The listener will retry at <T> with backoff of at least one second". The retry comes 4 minutes later.

This also changes behaviour. In push mode, between the due time and the deadline, renewal retries on the reconcile timer and not on the 30 s `RENEWAL_WINDOW_RETRY_MS` that folds 8 and 9 describe. My probe A (push, 1 h token, every renewal a 30 s timeout) found this. When the last reconcile was 60 s before due, only 3 attempts ended before a server clock 30 s ahead reached expiry. For the other starts at or before due it was 9-10. (This needs a wake subscriber with a topic. That is the normal case against a wake-capable server, in push mode and in poll mode.) The 1/s floor after the deadline still gives about 108 attempts in the 110 s margin for fast failures. So I found no case where the listener dies while an attempt could have succeeded. The status time is the defect. The lost retries are secondary.

Fix: after a transient read-path failure, and after `holdCredentialWindow` returns `"continue"` on the read path, set `forceRead = true`. The backoff is then the only wait, and the stated time is the true one. Add a test: a wake stub, a failing read, and an assertion that the next read happens at the `nextAttemptAt` in the `read_retry` or `credential_check` event, in both push and poll mode.

### P3. A worker turn can still move the first renewal attempt to expiry - 60 s (pre-existing, same effect as round-8 P1)

Nothing calls `bearer()` during a prompt (`cli.ts:3336-3340`). A turn is clamped to `expiry - TURN_BUDGET_CREDENTIAL_MARGIN_MS` with a margin of 60 s (`cli.ts:3332`, `:3352`). The listener cannot renew until the turn ends. `resolveTurnBudgetMs` calls `bearer()` at the start of the turn (`cli.ts:6687`), but that renews only if renewal is already due. Measured with the real `resolveTurnBudgetOrDefer` and a 1 h token (due at expiry - 360 s), default budget 600 s:

```
turn starts expiry-660s (due? false): budget 600s, ends at expiry-60s; deadline is expiry-110s
turn starts expiry-500s (due? false): budget 440s, ends at expiry-60s
turn starts expiry-400s (due? false): budget 340s, ends at expiry-60s
turn starts expiry-361s (due? false): budget 301s, ends at expiry-60s
```

A turn that starts in the 5 minutes before the due time and uses its budget ends at expiry - 60 s. Renewal (at the ACK's `bearer()`) then starts there. With a server clock up to 30 s ahead, one 30 s attempt fits. Round 8 ruled this exact result PRODUCTION when a wait caused it. Fold 11 capped waits, not turns. The 60 s constant is the same at a9846955, so this is not a regression. But invariant A's purpose (first attempt by deadline + floor, fold 12's 110 s budget) does not hold for a normal long turn. Fix: clamp the turn to `expiry - RENEWAL_WINDOW_EXPIRY_MARGIN_MS - now` and use the same bound for the defer check (`cli.ts:3382-3384`). Then renewal starts by the deadline. Add a test that crosses the due time with a turn.

## RIGOUR

**R1. `runtime.ts:1895-1898` vs `:1363-1365`: with an unknown expiry the claim retry event still gives the wrong delay.** Inside a credential window the `claim_retry` event now carries `capWaitMs(RENEWAL_WINDOW_RETRY_MS)` = 30 s. `holdCredentialWindow` sleeps `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` = 300 s when `expiry` is null. The `credential_check` event that follows corrects `nextAttemptAt`, so only the log line is wrong. The fold-11 test uses a known expiry (`start + 20 min`), so it cannot see this. Use the same expression as `holdCredentialWindow` for the event.

**R2. A fold-11 fixture listener leaked and is still running.** PID 41726, parent launchd, running for 51 minutes when I checked. Its command line is `node --import tsx …/scratchpad/wt-listener/src/cli.ts __listen-supervisor --url http://127.0.0.1:37173 … --state-dir …/T/cswarm-fold11-credential-check-PIXelR`. That state directory was created at 00:10 and was still being written at 01:01. Status: `starting`, `no_response`, read retry attempt 139. It is retrying against a loopback port that no longer answers. It is not mine and I did not stop it. The test's `finally` block ignores every stop error (`tests/listener-cli-process.test.ts:2307`, the same pattern at `:2253`). A timed-out or killed run can therefore leave a detached listener with no report. AGENTS.md says to kill your processes. The lead should check who owns it and stop it (`kill 41726`). The test should fail, or at least log, when stop does not end the process.

**R3. The fold-12 tests cannot see P1 or P2.** "a due session reports the deadline-capped push wait it takes" drives only empty claims. No test drives a delivery in push mode and then checks the cadence, the wake sentence or the lapse. No test checks that the time in a `read_retry` or `credential_check` event is when the next request happens, when a wake subscriber is present. The generated 736-sequence and 64-sequence tests have no wake subscriber.

**R4. Single-answer permanent stops that remain (listed as the brief asks; each is by design or local):** a recognised 426 `upgrade_required` (`renewal.ts:904`); the first failed renewal answer after local expiry (`renewal.ts:896-912`, `runtime.ts:1325-1328`); `h0_seat_uses_poll` (its own code and sentence); named local losses (`RenewalRevoked`, `RenewalReauthorisationRequired`, local credential state mismatch); and local journal or protocol faults. Folds 11 and 12 add no stop path and change no restart classification. I found no transient answer before local expiry that ends the listener. Probe A below: all 48 failing push and poll scenarios stopped only at local expiry, as `predecessor_expired_local`.

## Checked and correct

- **Invariant A (waits).** Probe A: real runtime and a real `AgentCredentialSession` (listener mode, memory store, 1 h token), push and poll, wake stub returning at `until`. Start offsets from due - 3000 s to due + 200 s. Renewal answers ok / 500 / 30 s timeout / 401. In all 64 scenarios the first renewal came at the due time, or at due + 1.019 s when the start was 1 ms before due (the floor plus the read). For a start after due, it came at the start. Every success renewed. The minimum gap between attempts was 1.000 s. There were about 108 attempts in the 110 s margin for fast failures. The supervisor restart cap (`supervisor.ts:1080-1088`) is the same predicate, and the lane's restart test passes. With no `getCredentialRenewalAt`, the supervisor keeps the old deadline cap.
- **Invariant B.** One-shot `bearer()` against the a9846955 archive and head. The inputs were 80 answers (200 ok, `null`, empty and HTML bodies; 400/401/403/404/409/426/429/500 with 5 bodies each; 11 rejection reasons and one unknown; a network error), each with a live and an expired token and each called twice. Result: **160/160 identical** in outcome, class, code, message, warnings and fetch count. Positive control: the same probe with head in listener mode differed from the base in 100 of 160. The `due()` refactor (`renewal.ts:840-864`) is the same predicate.
- **Invariant C.** One request per second at most after the deadline. The null store keeps its idle curve. The new `wakeWaitUntil` has a 1 s floor. After the deadline `mayWaitForWake` is false, so the planned wait is dropped (`runtime.ts:1518-1520`).
- The fold-12 margin test is not circular: it rebuilds the worst case from the allowance constants and `RENEW_TIMEOUT_MS` and requires 8 s of headroom.
- `plannedWakeUntil` is used at most once and is cleared on the branch that does not wait. It is computed before the poll-mode streak is incremented. This matches `idleSleep` and the documented 0-based curve (`idle-poll.ts:90-91`). In poll mode with a topic, the first empty wait is now 15 s, not 30 s, which is the documented curve.
- Every changed test file is in the literal `npm test` list (`listener-runtime`, `listener-control`, `listener-cli-process`, `idle-poll`, `listener-wake`), and `citation-drift` is under the `test:p1-cli` glob. The 8 fold-11/12 tests pass (exit 0).
- D-053: the fold-11/12 source diff adds no `.message` read (0 lines).
- Stop during any wait: unchanged. `defaultSleep` and the wake floor pass `abort`, and every caller checks `abort?.aborted`.

## Not established

- I did not run the full `npm test`, `test:p1-cli` or `build-release.sh`.
- The P1 event sequence was fed to the real supervisor from a fake `run`. I took it from the runtime code (`runtime.ts:1959`, `:2013`, `:1499`). I did not produce it with a real model turn.
- Rates and times come from a fake clock and fixed stub latency, not from real network load or a real DNS failover. I did not measure production clock skew or disk write latency (the 30 s and 5 s allowances).
- I did not measure how often a production turn crosses the due time (P3).

VERDICT: FAIL
