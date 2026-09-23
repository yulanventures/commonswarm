# D-036 Checker (Claude Opus), round 8: lane/listener-outage @ e5cbb626

Base a9846955. I read brief8, LANE.md "Fold 9" and "Fold 10", opus-r7.md and grok-r7.md, `git diff 2a273f89...e5cbb626 -- src/`, and the fold-10 test diffs. I read runtime.ts, supervisor.ts, renewal.ts and cli.ts at e5cbb626 in the detached worktree. `git status --short` in that worktree was empty before and after.

I ran tsx probes from `/private/tmp/opus8-probe`. They used stub fetchers, a fake clock that moves only by stated latency and by sleeps, and in-memory stores. They imported the worktree `src`, a `git archive a9846955 src` copy (invariant B), and a `git archive 2a273f89 src` copy (for comparison). They made no network call. I also ran a mutation on a copy of the worktree in that directory. I deleted the directory afterwards.

## Round-7 findings: status at e5cbb626

| Round-7 finding | Status |
|---|---|
| P1: zero wait from the deadline to expiry (50 req/s at 20 ms) | FIXED. `capWaitMs` floors every wait at `LISTENER_REQUEST_WAIT_FLOOR_MS` (`runtime.ts:975-982`). `paceRequest` puts 1 s between two requests when no wait came between them (`runtime.ts:1007-1022`). The wake wait gets the same floor (`runtime.ts:1479-1482`), and so do supervisor restarts (`supervisor.ts:1077-1082`). Measured: a renewal that answers HTTP 500 in 20 ms made 63 requests in the last 64 s before expiry, 1 per second, with one event per request. Then it stopped at expiry. |
| 60 s margin versus a 30 s timeout plus server clock lead | NOT FIXED on two paths. See P1 below. |
| R1: one-shot JSON `null` body differs from a9846955 | FIXED. See "Invariant B". |
| R2: stop sentence after expiry said "renewal was unavailable" | FIXED (`renewal.ts:894`, `:906`, `runtime.ts:1313`). |
| R3: a recognized 426 stops on one answer | Unchanged. LANE names it as a choice. See R4. |

## P1: PRODUCTION. The 92 s margin does not reach a push-mode listener or a restart wait that starts before renewal is due. The first renewal attempt can still come at about expiry − 60 s, which is the round-7 margin.

Fold 10 applies the deadline cap only while `renewalDue` is true:

```ts
// runtime.ts:978-979
const wait = expiry !== null && expiry !== undefined && now() < expiry &&
  options.credentialSession.renewalDue !== false && deadline !== null
```
```ts
// runtime.ts:1473-1474
const until = Math.min(reconcileDueAt, now() + waitCapMs(),
  options.credentialSession.renewalDue === false ? Infinity : renewalDeadline() ?? Infinity);
```
```ts
// supervisor.ts:1078-1081
const cappedDelayMs = deadline !== null && now() < expiry! &&
  options.getCredentialRenewalDue?.() !== false
  ? Math.min(proposedDelayMs, Math.max(0, deadline - now())) : proposedDelayMs;
```

`renewalDue` is `due()` (`renewal.ts:835-837`). `due()` is false until `renewalDueAt` = expiry − 6 min for the default 1 h token. A wait that starts before that time is not capped, so it can run past the deadline and end at any point up to its own length later. Two waits in the listener are longer than the 268 s between due time and the deadline:
- the push-mode wake wait: `waitCapMs()` returns `LISTENER_RECONCILE_POLL_MS` = 300 s (`runtime.ts:1230-1236`, `wake.ts:14`)
- the supervisor sustained restart: up to `LISTENER_RESTART_SUSTAINED_MAX_MS` = 300 s (`supervisor.ts:68`, `:107-113`)

Measured with the real `runListenerRuntime` and a real `AgentCredentialSession` (listener mode, memory store, 1 h token, deadline = expiry − 92 s). The listener was in push mode with the wake stub returning at `until`. The clock started at expiry − 365 s:

```
read at -365.0s ; pace 1000ms ; claim at -364.0s
wake wait from -364.0s until -64.0s (renewalDue at start=false)
renewal request at -64.0s            <- 28 s after the 92 s deadline
```

| Renewal answer | First renewal attempt | Attempts before expiry | Result |
|---|---:|---:|---|
| success, 20 ms | expiry − 64 s | 1 | renewed |
| 30 s timeout each time | expiry − 64 s | 3 (at −64, −33, −2 s) | `credential` stop, `predecessor_expired_local` |
| HTTP 500, 20 ms | expiry − 64 s | 63 (1 per s) | same stop |

The start time depends on the last reconcile. If the last claim was just before due time, the wake ends at due + 300 s = expiry − 60 s. The supervisor probe gave the same shape. The listener used 5 fast restarts, then a sustained restart that began at expiry − 361 s (renewal not yet due) and slept 300 s. The next run started at **expiry − 61 s**. At 2a273f89 the same push probe also first renewed at −65 s. So this is not a regression from fold 9. The problem is that fold 10's fix for the round-7 margin finding does not reach these paths.

Why this matters with the fold's own numbers. LANE Fold 10 says that "the first floor permits an attempt to start up to one second after the deadline". The 92 s is two 30 s timeouts, S = 30 s, and two floors. With a first attempt at expiry − 60 s:
- attempt 1 runs to −30 s
- attempt 2 starts at −29 s, which is after expiry on a server clock 30 s ahead

That is one usable attempt: the round-7 condition. With S = 0, one outage or DNS window that covers the last 60 s of a token still ends the listener for good at local expiry. The 6-minute renewal lead was meant to prevent this. For a quiet push listener the lead is in effect about 60 s, because it sleeps through the due time. Push is the normal mode when Realtime is subscribed. A DNS switch can leave the existing socket on the old backend, so the wake wait does not end early while HTTP requests fail.

The tests do not reach this span:
- The generated tests use lifetimes of 180–270 s (`listener-runtime.test.ts`, "generated renewal answer orderings keep a request floor…"). These are shorter than the 5-minute lead floor, so `due()` is true from the first instant.
- No test has a wait that starts before due time.
- On a copy of the worktree I replaced the wake `until` deadline term with `Infinity`, which removes the deadline cap from the wake wait entirely. `tests/listener-runtime.test.ts` still passed **111/111**.

Fix (small): base the cap on "this session can renew", not on "renewal is due now". That means a store is present, the expiry is known, and the session is not `unsupported`. A null-store or latched session keeps its idle cadence, which is what LANE Fold 10's first sentence describes. Better still, also cap waits at `renewalDueAt`, so the 6-minute lead is kept. Add two tests: one with a 1 h token and a push wake whose reconcile timer spans due time, and one with a sustained restart that spans due time. Each should assert that the first renewal attempt is no later than deadline + floor.

## Invariant B: holds (checked against a9846955 myself)

I ran one-shot `bearer()` (not listener mode) against the a9846955 archive and against the worktree. The inputs were 57 answers, each with a live and an expired token, and each called twice so that the probe also tests the latch:
- statuses 200, 400, 401, 403, 404, 409, 426, 429 and 500, each with the bodies `null`, `[]`, `42`, `"x"`, `true`, empty, non-JSON, `{}`, `unauthenticated`, a named revocation, and `upgrade_required`
- 11 rejection reasons, a rejection with no reason, a success, a replay, and a network error

Result: **228/228 identical** in outcome, message, warnings and fetch count. For example, `200 null` and `401 null` both warn "Cannot read properties of null…" and use the live token, as at the base. Positive control: the same probe with only the head in listener mode differed in 218 of 228. The fix at `renewal.ts:432` now rejects non-object bodies only in listener mode.

## Invariant C: rates in each state (1 listener; fleet of about 20)

| State | Requests | Status and log writes | About 20 listeners |
|---|---|---|---|
| Healthy, push | read + claim once per 300 s, plus claims on wake | idle and wake events per loop | under 0.1 req/s |
| Healthy, poll | read + claim every 15–60 s; the claim now comes 1 s after the read | 1 per loop | at most 2.7 req/s |
| Outage, read retry | backoff capped at 30 s (`SIGNAL_FOLLOW_BACKOFF_MAX_MS`), jitter 50–100 % | 1 `read_retry` per attempt | about 0.7–1.3 req/s |
| Credential window, token live | 1 sample per 30 s | 1 `credential_check` per sample | about 0.7 req/s |
| Deadline → expiry | at most 1 per s (measured 63 in 64 s) | at most 1 per s | at most 20 req/s, and only if every token's last 92 s line up; lasts at most 92 s |
| After local expiry | 1, then stop | 1 | — |
| Supervisor restarts in the deadline span | at most 1 run per s | 2 transitions + 1 log line per restart | same bound |

The 1 s floor is enough for the fleet. The rate is bounded by the backoff everywhere except in the last 92 s of a token, and there 20 req/s against a failing host for at most 92 s is harmless. The stop signal still ends every wait at once: `defaultSleep` removes its listener and clears its timer on abort (`runtime.ts:807-819`). `paceRequest` and the wake floor pass `abort`. After an aborted pace, `paceRequest` throws an `AbortError`, and every caller checks `abort?.aborted` first (`runtime.ts:1411`, `:1568`, `:1851`). No new branch reads `error.message` (D-053).

## RIGOUR

**R1. `cli.ts:5714-5716`: the credential-check sentence says "retrying renewal" when renewal is not happening.** The branch depends only on `renewalExpiresAt < credentialStopAt`. It does not check the edge or whether renewal is due. For a 1 h token, a confirmed read-edge loss between expiry − 10 min and expiry − 6 min produces "The listener is still running and retrying renewal at …". At that point the listener is retrying the read, because `due()` is false and `bearer()` sends no renewal. The test pins the sentence only with `credentialCheckEdge: "command"` (`listener-control.test.ts`, "credential and claim status use the answering edge…"). A neutral sentence would be "retrying at <t>".

**R2. The live control does not show the changed field.** Fold 10 changes what a running listener reports in `credential_check`: `nextAttemptAt`. The saved `fold10-detached-renewal-status.json` is the final `ready` state, with `nextAttemptAt: null` and no `credentialStopAt`. AGENTS.md asks for the live status JSON of the state that changed. Only unit tests show `nextAttemptAt` during `credential_check`.

**R3. `runtime.ts:1877-1891`: the claim retry event reports the wrong delay while the window is open.** When `credentialWindow !== null`, the `claim_retry` event carries `delayMs = capWaitMs(CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS)`, which is 300 s before the deadline. The wait that follows is `holdCredentialWindow`'s 30 s for a live token. The later `credential_check` event corrects `nextAttemptAt`, but the log line records 300000 ms for a 30 s wait. Fold 10 did not change this line.

**R4. Remaining single-answer permanent stops (by design, listed because the brief asks for them):**
- A recognized 426 `upgrade_required` in listener mode (`renewal.ts:477-480`, `:898`).
- After local expiry, the first failed answer on any edge, including a network error (`runtime.ts:1311-1313`, `renewal.ts:892-907`). The server fence refuses an expired predecessor, so after expiry this can only lose the few seconds of any server clock lag.
- An H0 seat refusal (`h0_seat_uses_poll`), which stops with its own code.
- Named local losses (`RenewalRevoked`, `RenewalReauthorisationRequired`).

I found no transient HTTP or network answer before local expiry that ends the listener.

**Observation (documented in LANE, not a finding).** The floor adds 1 s between a read and the claim that follows it, and between a claim and its ACK when the turn did not sleep. It also adds up to 1 s to a push wake that comes less than 1 s after the wait starts. The delivery lease and its 30 s safety margin absorb this.

## Checked and correct

- `capWaitMs` never returns less than 1 s, so `if (capped <= 0) return` (`runtime.ts:992`) is now dead code, which is harmless. Every loop wait passes through `sleep`, `paceRequest` or the wake floor.
- A null store (`due()` is false because `store === null`, `renewal.ts:848`) keeps the idle and wake cadence through expiry. The fold-10 test "…a healthy null-store listener stay rate bounded through expiry" passes. In listener mode `unsupported` is never latched, because 400/404/`renewal_unsupported` become `RenewalRetryError`, so `renewalDue` stays true once due.
- The status field `nextAttemptAt` is set from `credential_check` (`supervisor.ts:674`). It is cleared on `credential_check_cleared` (`:697`) and on stop. The value equals the wait that follows, because `emitCredentialCheck(capWaitMs(delayMs))` and `sleep(delayMs)` read the same `now()` (`runtime.ts:1352-1353`).
- The fold-10 tests are named in `npm test` (`listener-runtime`, `listener-control`, `listener-cli-process`) or globbed by `test:p1-cli`. I ran the 30 renewal, deadline, floor, wake and restart tests at e5cbb626 and all passed. The generated tests take their expected outcomes from the answer sequence, so they are not circular. But they cannot reach the pre-due span (P1).

## Not established

- I did not run the full `npm test`, `test:p1-cli` or `build-release.sh`. I started no listener.
- The rates come from a fake clock with a fixed stub latency, not from real network load.
- I did not measure how often a production push listener's reconcile timer spans its token's due time. By arithmetic this happens whenever the last reconcile was 0–300 s before due, which is most renewals for a quiet push listener. I also did not measure production clock skew.
- I did not check whether a DNS switch keeps the existing Realtime socket open. P1's outage case depends on the wake wait not ending early.

VERDICT: FAIL
