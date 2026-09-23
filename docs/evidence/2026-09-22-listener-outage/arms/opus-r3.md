# D-036 Checker (Claude Opus), round 3: lane/listener-outage @ 84b62913

Base a9846955. I read brief3, LANE.md (Folds 1-5), both round-2 reviews, `git diff 08c27a3c...84b62913 -- src/`, and the
code at 84b62913 in `src/listener/runtime.ts`, `src/listener/supervisor.ts`, `src/listener/control.ts`,
`src/cloud/delivery.ts`, `src/cloud/signals.ts` and `src/cli.ts`. I also read `supabase/functions/read/index.ts` (auth
refusals), `supabase/functions/command/index.ts` (pre-auth and auth order) and `supabase/functions/_shared/agent-auth.ts`
(session proof fence). I ran one tsx probe from a temporary folder under /private/tmp. It copied the fixtures of
`tests/listener-runtime.test.ts` (test calls stubbed out), imported the worktree `src` by absolute path, used a stub
`fetcher`/`readPage`, a fake clock and a temporary HOME, and made no network call. I deleted the folder. The worktree
is clean. This file is the only file I left.

## Round-2 findings: status at 84b62913

| Round-2 finding | Status |
|---|---|
| Opus N1 / Grok F1: forced read reset the claim back-off (hot loop) | FIXED. `deliveryAttempt` is hoisted (`runtime.ts:1307`), the sleep runs before the forced read (`:1729-1737`), and only a successful claim resets it (`:1746-1750`). The read success no longer emits `claim_retry_cleared`. Probe, one simulated hour, reads succeed, claims 503 (and claims 401), seeded jitter: 249 reads + 251 claims = **8.3 requests/min**, 4.2 retry events (status write + log line) per minute. Sleeps 0.5 → 30 s cap. Round 2 measured about 300 requests/min. |
| Opus N2 / Grok F3: startup read failure unnamed | FIXED. `read_retry` is emitted before `ready` (`runtime.ts:1435-1455`), the supervisor stores the code and next attempt in `starting` (`supervisor.ts:710-716`), and status and start name the code (`cli.ts:5709-5722`, `:6100-6110`). The sentence says "Check the target URL", but no status field records that URL (R2 below). |
| Grok F2: non-JSON / 400 / 404 / 426 claim or ack answer stopped for good | FIXED for those four statuses and for a 2xx body outside the envelope (`delivery.ts:745-760`, `runtime.ts:578-602`). Probe control: claim 404 HTML retried with sleeps 500…30000 and code `http_404`. The same classifier still stops the listener on other foreign statuses (P1). |
| Grok F4: malformed-row overflow and bad marker untagged | FIXED. `signals.ts:309`, `:592` now throw `SignalMalformedError`. |
| Opus R1: running-state lists typed by hand | FIXED. `LISTENER_RUNNING_STATES` (`control.ts:73-75`) is used in `cli.ts`, `supervisor.ts` and `parseStatus`. |
| Opus R2: local state mismatch reused the credential stop | FIXED. `ListenerCredentialStateMismatchError` with code `local_credential_state_mismatch` and its own sentence (`cli.ts:5734-5736`). The race between two `bearer()` calls is still not established either way. |
| Opus R3: H0 sentence told the reader to stop a stopped listener | FIXED (`delivery.ts:85-86`). |
| Opus R4: stale fields, "refused" for transport, CONNECTED during check | FIXED. The restart, stop and failed transitions clear `credentialCheckEdge` and `claimRetryCount`. The claim sentence separates "could not be reached". `credential_check` is not CONNECTED. |

## P1: PRODUCTION. One foreign answer with a status outside {400, 404, 426} still stops the listener for good, on the read edge and on the command edge

The lane's rule for a foreign answer is a short list of statuses, not "not our envelope":

```ts
// runtime.ts:578-581
function isForeignDeliveryHttpResponse(error: DeliveryHttpError): boolean {
  return !error.recognizedEnvelope &&
    (error.status === 400 || error.status === 404 || error.status === 426);
}
// runtime.ts:515-517 (read)
  return http !== null && (http.status === 400 || http.status === 404 ||
    http.status === 426);
```

Any other 4xx that is not 401, 403 or 429 is not retryable (`isRetryableDeliveryError`, `runtime.ts:593-602`;
`isRetryableFollowError`, `signals.ts:2415-2433`). It is also not restartable (`isRestartableRuntimeError`,
`runtime.ts:470-474`; `isRestartableReadError`, `signals.ts:843-844`). So the runtime returns `fatal` and the supervisor
does not restart it.

Probe, same invocation, with a 404 control that retried:

```
claim 404 html (control)  stop cancelled  restartable n/a  claims 10  sleeps 500..30000  code http_404
claim 405 html            stop fatal  restartable false  DeliveryHttpError  claims 1  sleeps []
claim 408 html            stop fatal  restartable false  claims 1
claim 421 html            stop fatal  restartable false  claims 1
claim 413 html            stop fatal  restartable false  claims 1
read 404 html (control)   stop cancelled  requests 5  sleeps [446,785,1620,3692,5646]
read 405 html             stop fatal  restartable false  requests 1
read 408 html             stop fatal  restartable false  requests 1
read 421 html             stop fatal  restartable false  requests 1
```

On the command edge the client already knows the body is not ours (`recognizedEnvelope === false`, `delivery.ts:724-741`).
Our own read edge sends 405 only for a method other than POST (`read/index.ts:384`), and this client always sends POST.
So a 405 on either edge must come from something that is not the CommonSwarm edge. 408 is a timeout answer, and the
brief names a timeout as transient. A proxy, a load balancer or a static host at a wrong URL can send any of these
statuses. The measured incidents were a DNS switch and a 500. This is the brief's "one transient or foreign answer stops
a listener for good" case. LANE.md's Fold 5 table does not list this class, so it is not disclosed.

Fix: on the command edge, retry every HTTP status whose body has no recognized envelope (with code `http_<status>`).
On the read edge, retry every 4xx other than a confirmed credential code or a recognized refusal of our own. Add 405 and
408 cases, one for each edge, to the foreign-response tests.

## P2: PRODUCTION. A managed seat whose claim needs a session proof retries forever with code `unknown_error` and no next step

The command edge fences a managed principal before the claim. With no proof header it returns
`401 {"error":"session_proof_missing"}` (`_shared/agent-auth.ts:214-257`, `command/index.ts:8927-8943`,
`session-wire.ts:198`). `session_proof_invalid` and `session_expired` are also 401. The listener sends no proof when it
finds no live local session context. The code comment says so: "None: legacy path, the server fences a managed
principal" (`cli.ts:6461-6466`). The session codes are not in `DELIVERY_SERVER_ERROR_CODES` (`delivery.ts:97-111`), so
`refusal()` collapses them to `unknown_error`. A 401 with an unconfirmed code retries without end
(`runtime.ts:600-602`).

Probe: claim `401 session_proof_missing`, reads succeed. The claim-retry code is `["unknown_error"]`, the sleeps rise to
30 s, and over one simulated hour it keeps 8.3 requests/min without end. Status then says:

> The claim failed (unknown_error) N times. The command edge did not accept the claim. The listener is running and will
> try again at T, reading signals after repeated failures.

It also shows `CONNECTED: yes` (`cli.ts:5322-5324` counts `claim_retry` as connected). This will not heal without an
operator action: start a session, or stop the listener. No message is delivered, and status gives no cause and no next
step. At base the same answer was an immediate `credential_stopped`, so the operator saw a stop. The brief requires a
retry for a 401 without a confirmed code. That part is correct. What is missing is the status. It has to name the cause
(add the session codes to the recognized vocabulary, or record them as their own code) and say what to do. That is
AGENTS.md "Honesty is not sufficient" and the brief's "retries forever on something that can never heal without saying
so in status".

## R1: RIGOUR. `listen start` blames the read edge for any code it finds in `starting`

`cli.ts:6100-6110`:

```ts
if (status.state === "starting" && status.lastErrorCode) {
  ...
    : `Listener read edge failed (${code}); check the target URL and read edge version. ...`;
```

The supervisor's restart transition also writes `starting` plus `lastErrorCode = safeErrorCode(stop.error)` for any
restartable stop (`supervisor.ts:1030-1045`). Examples are a transient ACP code (`runtime.ts:491`), a transport error, or
a `DeliveryResponseError`. After the restart sleep only `nextAttemptAt` is cleared (`:1054`). If the 120 s start wait
ends in that state, `listen start` prints "Listener read edge failed (<acp code>)", and that is false. The status
sentence avoids this because it checks `readHealth.currentEpisodeAttempts`. The start message does not.

## R2: RIGOUR. "Check the target URL" names no URL

The start and status sentences tell the reader to check the target URL (`cli.ts:5718-5721`, `:6107-6108`). No status
field or rendered line records that URL (`control.ts` and `renderListenerStatus` have none). The brief's claim that
start and status "name the URL" is true only for the word, not for the value. The reader has to find out which URL the
detached process was started with.

## R3: RIGOUR. Status freshness while claims keep failing

- In `claim_retry`, a forced read that then fails transiently does not update `nextAttemptAt`, because the supervisor
  sets it only in `starting` (`supervisor.ts:712-716`). Status keeps the claim's time, which is now in the past, while the
  read backs off.
- `credential_check_cleared` goes to `ready` (`supervisor.ts:653-661`) even when `claimRetryCount > 0` and claims are
  still failing. Status says ready until the next claim failure.
- The capability-code triple is typed by hand in three places (`cli.ts:5715-5717`, `:6103-6105`, `:6250-6254`). These
  are classifiers, not a list shown to the user. They can still drift from `ListenerCapabilityError` codes.
- Load in a lasting claim outage is about 4 status writes and 4 log lines per minute per listener. That is about 6,000
  log lines a day, and `appendListenerEvent` has no size bound. This is acceptable, but it is not recorded.

## Checked and correct

- Stop paths (every `reason:` in `runtime.ts`): cancelled on abort in every wait (claim sleep `:1734`, window
  `:1210-1211`, ACK `:1299`, wake wait, restart sleep `supervisor.ts:1049`). `credential` comes only from a local loss
  (renewal horizon, missing secret, state mismatch) or from a complete window. Fatal on server answers now covers only
  recognized well-formed refusals, accepted-envelope protocol defects, H0, `delivery_configuration_missing`, and P1.
- Window arithmetic: 3 confirmed checks and at least 10 minutes (`runtime.ts:1194-1199`). A transient answer extends it,
  and a successful read, claim or ACK clears it. A command-edge `401 unauthenticated` alone stops after 10 minutes even
  while reads succeed. That is a confirmed code from the command auth path (`command/index.ts:8915-8925`), so it
  matches the brief.
- Read-edge `forbidden` is only `agent.is_revoked` (`read/index.ts:474-475`). The other auth refusals there are 401
  `unauthenticated`.
- A claim-only failure cannot loop without reaching the window. After 3 refusals each failure forces a read, and a
  revoked seat's read opens the window. The claim sleep and the forced read now share one growing back-off. The fold-4
  test drives reads that succeed and asserts sleeps `[500 … 30000, 30000]`, state `claim_retry` and counts 1-8. The
  Maker's mutation control is recorded.
- The fold-5 envelope check matches the first check that `parseClaimSuccess`/`parseAckSuccess` already made
  (`delivery.ts:565`, `:640`), so no legitimate answer becomes a retry. A recognized `400 invalid_request` stays fatal.
  The command edge sends it before auth only for a malformed `command_id` (`command/index.ts:11178-11189`), and this
  client never sends one.
- Supervisor: fast restarts reset after 60 s clean (`supervisor.ts:1011-1015`). Production passes no `maxAttempts`,
  so a restartable stop continues at the 5-minute sustained cap.
- New and changed tests are in the literal `npm test` list (`listener-runtime`, `listener-control`,
  `listener-cli-process`, `listener-host-limits`, `listener-engine`, `delivery-client`, `support/agent-receive-cli`) or in
  the `test:p1-cli` glob. The foreign-claim, foreign-ACK and startup tests use the real `DeliveryCommandClient` /
  `readAgentSignalPage` through a stub `fetcher`, so they are not circular.
- `fold5-detached-status.json`: `claim_retry`, `http_404`, `nextAttemptAt` about 0.5 s after `updatedAt`,
  `claimRetryCount` 1, check fields null.
- `inbox --follow` still stops on one confirmed read code. The reported incidents were listeners, so this does not
  block (disclosed).

## Not established

I did not run the package gates or the test files. My probe ran the runtime only, with no supervisor for the P1 cases.
The non-restartable result comes from `isRestartableListenerStop` on the returned stop. I did not start a listener. I did
not show which exact status a given proxy, Cloudflare or the site Caddy returns for a wrong URL. P1 rests on what the
classifier does with any such status. I did not show how often a managed seat runs `cswarm listen` with no live session
context, or whether `session_expired` can happen during a run.

VERDICT: FAIL
