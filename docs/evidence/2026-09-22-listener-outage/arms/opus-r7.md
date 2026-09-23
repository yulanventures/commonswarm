# D-036 Checker (Claude Opus), round 7: lane/listener-outage @ 2a273f89

Base a9846955. I read brief7, LANE.md "Fold 9", opus-r6.md and grok-r6.md. I also read `git diff 402c7a71...2a273f89 -- src/`, and I diffed `a9846955:src/cloud/renewal.ts` against the worktree copy line by line. I read the runtime, supervisor and `cli.ts` code at 2a273f89 in the detached worktree.

I ran two tsx probes from `/private/tmp/opus7-probe`. They imported the worktree `src` and a `git archive a9846955 src` copy by absolute path. They used stub fetchers, a fake clock, and in-memory stores. They made no network call, and I have deleted the directory. I also ran the Fold 9 tests from that directory: the 3 generated/expiry tests in `tests/listener-runtime.test.ts` and the renewal tests in `tests/p1-cli/renewal-listener-samples.test.ts`. All passed (19 + 3, 0 fail). `git status --short` in the worktree is empty.

## Round-6 findings: status at 2a273f89

| Round-6 finding | Status |
|---|---|
| P1: one transient answer inside a renewal window slept 5 min past expiry | FIXED. Every sample waits `RENEWAL_WINDOW_RETRY_MS` (30 s) while the token is live (`runtime.ts:1321`). Every wait is capped at `expiry - 60 s` (`runtime.ts:968-984`). My probes found no sleep past the deadline, and the 736-sequence test agrees. |
| P2: one-shot `bearer()` threw on renewal_unsupported / grant_not_found / device refusals / 426 | FIXED. Invariant B holds for 74 of 76 cases. The one exception is RIGOUR (R1 below). |
| R1: renewal_unsupported / device refusal stopped the listener on one answer | FIXED. They become `RenewalRetryError` until expiry. |
| R2: `credential_check` sentence was false once expiry came before stopAt | FIXED (`cli.ts:5714-5716`). |
| R3: 5 s margin | Changed to 60 s, and LANE.md gives a reason. See "Checked". |

## P1: PRODUCTION. After the renewal deadline every wait is zero, so the listener sends one request per round trip for the last 60 s of the token

`capWaitMs` caps every wait at `deadline - now`. Once `now >= deadline`, this is `Math.max(0, deadline - now())` = 0. The sleep wrapper then does not wait at all:

```ts
// runtime.ts:968-984
const capWaitMs = (ms: number): number => { ...
  return expiry !== null && expiry !== undefined && now() < expiry && deadline !== null
    ? Math.min(ms, Math.max(0, deadline - now())) : ms;
};
const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  const capped = capWaitMs(ms);
  if (capped <= 0) return;
```

The cap applies to every wait in the runtime:
- idle polls (`:996`)
- the confirmation window (`:1321`, through `sleep`)
- ACK retries (`:1412`)
- read retries (`:1564`)
- claim retries (`:1834`)

`mayWaitForWake()` also skips the wake wait in `[deadline, expiry)`. From the deadline to local expiry, the listener therefore has no backoff: it sends one request for each round trip. The supervisor does the same for restarts: `supervisor.ts:1076-1078` caps the restart delay at `deadline - now` = 0. The supervisor has no ceiling, so a restartable stop in that span restarts at once with no limit (I found this by reading the code; I did not measure it).

The token is 1 hour, so renewal is due 6 minutes before expiry. The fetch latency is fixed in the stub, and the clock moves only by latency and sleeps. Requests per span:

| Scenario | before due | due → deadline (5 min) | deadline → expiry (60 s) | after expiry | stop |
|---|---:|---:|---:|---:|---|
| S1 no store (renewal never due), healthy reads, 20 ms | 4 | 5 | **3000** | 1 | none (healthy) |
| S2 renewal HTTP 503, 20 ms | 4 | 17 | **3000** | 0 | credential, `predecessor_expired_local`, at expiry |
| S3 renewal connection refused, 2 ms | 4 | 17 | **30000** | 0 | same |
| S4 renewal 401 `unauthenticated` (ours), 20 ms | 4 | 9 | **3000** | 0 | same |
| S5 renewal 200 `rejected: renewal_unsupported`, 20 ms | 4 | 17 | **3000** | 0 | same |
| S6 renewal foreign 401 HTML, 20 ms | 4 | 17 | **3000** | 0 | same |

In each failing case, the runtime also emitted about one event per request in that span: 2999, or 29999 at 2 ms. Each `read_retry`, `credential_check` or `idle_poll` event makes the supervisor run `persist()` and write one log line (`supervisor.ts:568-583`, `:753-786`). That is thousands of status-file writes and events.ndjson lines per listener per minute.

After expiry the load is bounded: the first failed answer stops the listener, because `runtime.ts:1280-1283` and `bearer()` return `predecessor_expired_local`. The rate from the deadline to expiry is 60 s ÷ RTT in every failing order, including mixed orders, because every failure kind gets a zero wait.

Who meets this:
- **An outage of 5 minutes or more that covers renewal time and fails fast.** Examples: a foreign backend during a DNS switch, Caddy 502, or connection refused. This is the class of the 2026-09-16 incident (a 5-minute switch to a backend that answered quickly). Every affected listener floods the failing or foreign host for one minute before it stops. The brief requires backoff, and this gives none.
- **A healthy server, without any outage (S1, S5).** One case is a listener whose credential store failed its checks: `cli.ts:3107-3122` sets `store` to null, so `due()` is false for the life of the token. The other is a grant that answers `renewal_unsupported`, `renewal_grant_not_found` or a device refusal. Each such listener sends thousands of read or renewal requests at production in the last minute of every token. At a9846955 these listeners kept their idle cadence (S1), or latched `unsupported` and sent no further renewals (S5).

The tests do not reach this span. The generated recovery test (`listener-runtime.test.ts`, "generated renewal answer orderings…") uses a fetcher that never moves the clock. Every sequence has at most four failures and then a success. With the 35 s lifetime, the whole run is already past the deadline, and time never advances. No test sets a limit on requests or a minimum wait after the deadline. A mutation that makes `capWaitMs` return 0 for every call still passes that test (I checked this by reading the code; I did not run the mutation). LANE.md Fold 9 says the load after the deadline "has not been load-tested". It is 60 s ÷ RTT.

Fix: give a floor to the wait after the deadline. For example, use `max(deadline - now, N s)`, or space attempts by the renewal timeout. Apply the cap only while a renewal can happen (`store !== null`, not latched, due). Do not cap idle polls or wake waits for a session that cannot renew. Apply the same floor to the supervisor restart delay. Add a test whose fetcher moves the clock and which asserts a limit on requests in `[deadline, expiry)`.

## R1: RIGOUR. Invariant B differs from a9846955 when a 200 answer has the body `null`

I ran a probe that compares a9846955 with 2a273f89 for one-shot `bearer()`. It uses 38 renewal answers, each with a live and an expired token, and each is called twice so that it also tests the latch:
- 400, 404, 401, 403-HTML, named 401, 426 with and without a body, 409, 429, 500 and a network error
- all 11 rejection reasons, an unknown reason and a missing reason
- a good successor and a replay
- a malformed token, missing ids, missing expiry, a TTL that is too long, and a bad wake, horizon, successors or issued_at
- a successor with no status, and the bodies `null`, `[]`, non-JSON text, a bad principal, and `ok: false`

74 of 76 results are identical: outcome, message, warnings and fetch count. The two differences are both the JSON body `null`. At a9846955 that body threw `TypeError` at `body.principal_id`, so the command warned and ran (live token) or rethrew the TypeError (expired token). At 2a273f89 it becomes `{}` (`renewal.ts:430-438`), which is read as a replay: `RenewalRevoked("successor_not_recoverable")`. The command fails with the sentence "This agent credential renewed itself, but the answer was lost in transit…". Nothing shows that this happened. The base already said the same thing for `[]` and non-JSON bodies, so this is an edge case. It is still a difference that the 20-row table and LANE.md do not cover.

## R2: RIGOUR. The stop message after expiry names the wrong cause when the server confirmed the loss

S4: our backend answered 401 `unauthenticated` to every renewal from due time on. The listener stopped at expiry with "The current credential expired while renewal was unavailable" (`runtime.ts:1282`, `renewal.ts:888-891`). Renewal was available and it refused the credential. The sentence says that renewal was unavailable, which the listener did not measure. A neutral sentence would be: "The current credential expired before it could be renewed."

## R3: RIGOUR. A recognized 426 still stops the listener on one answer

When a backend running our code answers 426 `upgrade_required` with `min_client_version`, the listener stops at once (`renewal.ts:477-480`, `RenewalUpgradeRequiredError` is rethrown in listener mode). During a DNS switch to another of our deployments with a different version gate, one answer ends the listener for good. LANE.md names this choice ("remains the named listener version stop"). The brief lists what counts as transient, and 426 is not on that list, so I rate this RIGOUR. I note it because the brief asks for every remaining single-answer stop.

## Checked and correct

- **Invariant A before the deadline.** No wait crosses `expiry - 60 s`. The confirmation window samples every 30 s while the token is live, and a transient sample keeps the window. Every stop in S2–S6 happened at local expiry, not before. The 64-sequence window test requires at least three confirmed checks and the full 10-minute span. It cannot pass if waits go to zero, because time would never reach the span.
- **Margin.** 60 s covers a 30 s renewal timeout plus 30 s of skew. The argument holds for server clocks less than about 60 s minus latency ahead of the client. Because attempts continue with zero wait until local expiry, the margin only ensures an attempt at the deadline. LANE.md states the limit on skew.
- **Status.** `renewalExpiresAt` now goes through `credential_check`, and the supervisor clears it on `credential_check_cleared` and on stop. The new sentence (`cli.ts:5714-5716`) takes its codes from `COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES` / `CONFIRMED_CREDENTIAL_LOSS_CODES`, and it matches the stop on the next failed answer after expiry. `cli.ts:6772` forwards `getCredentialExpiryMs` to the supervisor.
- **Restarts.** `ListenerLeaseResponseError` is now restartable, and the supervisor's restart delay grows to its sustained cap (outside the deadline span).
- **Stop.** `cswarm listen stop` still ends the zero-wait loop: every loop checks `abort` after the (skipped) sleep.
- **D-053.** The new branches use `instanceof` and never read `error.message`.
- **Test gates.** `tests/listener-runtime.test.ts`, `tests/listener-control.test.ts` and `tests/listener-cli-process.test.ts` are named in `npm test`. `tests/p1-cli/renewal-listener-samples.test.ts` and `citation-drift.test.ts` are globbed by `test:p1-cli`.
- **Circularity.** The generated tests are not circular: the expected outcomes come from the answer sequence, not from the implementation. The one-shot table agrees with my own comparison against a9846955 on everything except the `null` body.

## Not established

- I did not run `npm test`, `test:p1-cli` or `build-release.sh`, and I started no listener.
- The rates in P1 come from a fake clock with fixed stub latency. Real rates depend on RTT. The supervisor restart hot loop comes from reading the code, not from a probe.
- I did not measure how often production listeners run with a null credential store, or hold grants that answer `renewal_unsupported` or a device refusal.
- I did not trace what the command edge answers for an expired predecessor.

VERDICT: FAIL
