# D-036 Checker (Claude Opus) — lane/listener-outage @ 93bbd6cd

Base a9846955. I read LANE.md including Fold 1, the full diff, `src/listener/runtime.ts`, `src/listener/supervisor.ts`,
`src/cloud/signals.ts`, `src/cloud/delivery.ts`, the changed parts of `src/cli.ts`, `supabase/functions/read/index.ts`,
the revocation branch of `supabase/functions/command/index.ts` at 93bbd6cd, and `h0-seat.ts` plus the claim fence on
`lane/h0-poll-ack`. I did one direct in-process run in the detached worktree (`node --import tsx --input-type=module -e`,
fake `fetcher`, no network, no file written there). Process note: for a moment I wrote a scratch copy of
`command/index.ts` (`.cmd.ts`) in the arms-listener scratch folder so I could read it. I deleted it. This review is the
only file I left.

## F1 — PRODUCTION: on the production read path, one confirmed read code still stops the listener for good. The Fold 1 window never runs there.

`src/listener/runtime.ts:512-527`:

```ts
function isLocalCredentialLoss(error: unknown): boolean {
  if (error instanceof RenewalReauthorisationRequired || error instanceof RenewalRevoked) return true;
  if (error instanceof CommandHttpError || error instanceof DeliveryHttpError || error instanceof SignalHttpError) return false;
  return isFollowCredentialFailure(error);
}
```

The production `readPage` (`runtime.ts:988`) calls `readAgentSignalPage`. That function fails through `throwSignalHttp`
(`src/cloud/signals.ts:656-670`, called at `:1221`), and `throwSignalHttp` throws a **plain `Error`** that is tagged
through the `plainHttpStatus` and `plainHttpEnvelope` WeakMaps. It is not a `SignalHttpError`. So the exclusion does not
match. `isFollowCredentialFailure` then reads the tagged status plus envelope, `isConfirmedCredentialHttpFailure(403,
"forbidden")` returns true, and the read catch at `runtime.ts:1356-1358` sets `stop = { reason: "credential" }` at once.
`isServerConfirmedCredentialLoss` (`:534`) has a plain-error branch at `:545` that would handle this correctly, but it is
never reached. The supervisor then writes `failed` / `credential_stopped` (not restartable).

Direct run at 93bbd6cd with the real `readAgentSignalPage` path (a fake `fetcher` gave the answer, and `now` and `sleep`
advanced a fake clock):

```
production read error: instanceof SignalHttpError = false name = Error isFollowCredentialFailure = true
{"error":"forbidden",...} 403        => stop = credential | read HTTP requests = 1 | elapsed ms = 0 | events = []
{"error":"unauthenticated",...} 401  => stop = credential | read HTTP requests = 1 | elapsed ms = 0 | events = []
{} 403                               => stop = cancelled  | read HTTP requests = 21 (retried until I aborted)
```

There was one request, zero elapsed time, and no `credential_check` event. This is the incident the lane exists to fix:
a foreign backend during a DNS switch answers `unauthenticated` for a token it does not know. A 5-minute switch would
still kill the listener for good. The command edge (`DeliveryHttpError`/`CommandHttpError`) does reach the window. The
read edge, which is the check the window is designed around, does not.

Why the tests pass: every Fold 1 runtime test injects `readPage` that throws `new SignalHttpError(...)`
(`tests/listener-runtime.test.ts`, `forbiddenRead()` and all the window tests). Production never throws that type. The
Fold 1 mutation ("holdCredentialWindow returns credential immediately") also went through the same typed seam. So the
tests show the window works for an error shape that production does not make. LANE.md "Fold 1" says: "A single
confirmed code is no longer a permanent stop". That is false for the read edge. Fix: make `isLocalCredentialLoss` return
false for any error where `followHttpDetails(error) !== null`. Add a runtime test that uses the default `readPage` with
a stub `fetcher`, and do not inject `SignalHttpError`.

## F2 — PRODUCTION: a listener whose only failing call is the claim POST loops forever. It never reaches the window and never reads again.

`runtime.ts:1602-1660`: `while (result === null && !stop) { ... claimAgentInbox ... }`. For a 403 without a confirmed
command code, `isRetryableDeliveryError` is now true (`:257-258`, `status === 401 || status === 403`). The loop sleeps
`deliveryRetryDelay` (cap 30 s) and tries the claim again. It never goes back to the outer loop, so it never does the
signal read that the lane relies on as the credential check. For a revoked agent, the command edge answers every claim
with `403 delivery_unavailable` (command/index.ts at 93bbd6cd, the `revoked()` branch:
`return { status: 403, body: { error: isDeliveryCommand ? "delivery_unavailable" : "forbidden" } }`). Before this lane,
`isDeliveryCredentialLoss` stopped that case. Now a revoked listener claims every ≤30 s for the life of the process.
The claim retry emits no event, so status stays `ready` with no error (the throughput lapse may show after an hour).
This path is reachable in production: in push mode a wake sets `skipRead = true` (`:1270-1290`), so the claim runs with
no read before it. Once the claim loop is entered, the reconcile read never runs. The ack path is limited by the lease
(`staleUnavailable` at `:1212-1224`), but the claim path has no limit. If a command-edge `unauthenticated` already
opened the window, a later `delivery_unavailable` counts as a "transient" sample and pushes `credentialStopAt` out
forever (`:1640-1646`), so status keeps saying "will stop at X" and X keeps moving. LANE.md admits it did not prove
that such a listener reaches the read. It does not. Expected: after N claim refusals, exit the claim loop to the outer
loop, so the next read (the credential check) decides.

## F3 — PRODUCTION (low): a status run from another directory says `ATTENDING: none. Signals queue and nothing wakes the session.` while a hook is installed

`cli.ts:7251-7253`: `cswarm listen status` passes `cwd: process.cwd()` to `collectListenerAttendanceEvidence`. That
function now depends only on `listenerSettingsHookInstalled(cwd, …)`. The default `hook install claude --write` scope is
`<project>/.claude/settings.local.json` (usage text, `cli.ts:977-979`). Before, the hook-surface file masked this
dependence on cwd. Now, if status runs anywhere except the listener's project, a hook that is installed reports
"nothing wakes the session". That is a new false negative. It trades the false `ATTENDING: hook` for a false
`ATTENDING: none`. The listener's `--cwd` is not in status, so status cannot check the correct project. The one test
(`tests/p1-cli/listener-outage-attendance.test.ts`) passes the same `cwd` it wrote the settings into, so it cannot see
this.

## F4 — RIGOUR: the new `credential_check` state is missing from the running-state lists in the start paths

- `cli.ts:6876-6878`: the `listen start` guard lists `starting | ready | stopping` and does not include
  `credential_check`. A second start against a live listener in `credential_check` goes past the guard and fails later
  with a different error.
- `supervisor.ts:1164-1166` (`waitForListenerReady`) returns only on `ready`. A start whose first read enters
  `credential_check` waits 120 s, then throws `ListenerStartupError(lastErrorCode)`, and prints
  `listener failed (unauthenticated); check cswarm listen status…` (`cli.ts` fallback). But the process is still alive,
  and it can still recover. Today F1 hides this. It becomes reachable when F1 is fixed.
- The same state lists are typed in by hand in `control.ts:514`, `supervisor.ts:1091-1094`, `cli.ts:6876`. No shared
  constant, so the next state will drift the same way.

## F5 — RIGOUR: the user-facing code list does not come from the constant that decides the command edge

`cli.ts:5693-5698` `credentialCheckSentence` always prints `CONFIRMED_CREDENTIAL_LOSS_CODES.join(" or ")` ("unauthenticated
or forbidden"), which is the read-edge set. A window opened by a claim or ack uses `COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES`
(only `unauthenticated`), and command-edge `forbidden` is exactly what the lane says is **not** a credential check. The
code that was received is in `lastErrorCode`, but the sentence does not use it. Also, `credentialStoppedSentence`
(`:5688`) covers the local stops as "a local renewal stop fired". `isFollowCredentialFailure` also stops on a missing
local secret (`/secret is absent/`), and the sentence does not name that cause.

## F6 — RIGOUR: other answers a foreign backend can give still end the listener for good

The brief's list of transient failures (network, 5xx, timeout, 401/403 without a confirmed code) is now covered on the
read path, except for F1. But in a DNS switch to another stack, a 404/400/426 answer, an HTML 200
(`SignalMalformedError`), or a 200 without the listener capabilities (`ListenerCapabilityError`, `runtime.ts:486`,
never restartable) still gives `fatal` and is not restartable. `isRestartableReadError` returns false for any other 4xx.
This is outside the brief's list, so I do not count it as a defect. But LANE.md presents "survives a server outage"
with no limit, and these answers are the same incident class. It should state this as not established.

## F7 — RIGOUR: `cswarm inbox --follow` still stops on one confirmed read code

`cli.ts:4943-4947` passes `isFollowCredentialFailure` to `runInboxFollow`. One `unauthenticated` from a foreign backend
ends follow, and the D-056 exit code tells a supervisor not to restart it. The reported incidents were listeners, so
this does not block the lane, and LANE.md discloses it. It is the same outage mode for any seat that is attended by
follow.

## F8 — RIGOUR: the H0 stop sentence does not tell the reader what to do next

`delivery.ts:85` / `cli.ts:5717`: "This seat is a link-joined (H0) seat that receives messages through the h0 poll, so a
cswarm listener cannot serve it." It says what is true, but it does not say what to do (for example: do not start a
listener for this seat, and the seat's host must use `POST /functions/v1/h0/poll`), as AGENTS.md "Honesty is not
sufficient" requires. The code path is correct otherwise. The claim fence on `lane/h0-poll-ack` returns HTTP 403 with
`error: "h0_seat_uses_poll"` (command/index.ts on that branch, around line 9317). That matches `isH0SeatClaimRefusal`.
`isRetryableDeliveryError` excludes the code whatever the status is. `isRestartableRuntimeError` returns false. The
delivery allowlist keeps the slug.

## Checked and correct

- Read-edge `forbidden` is only `agent.is_revoked` (`supabase/functions/read/index.ts:475`). Every read-edge
  `unauthenticated` (`:388, :416, :422, :471`) is a missing, unknown, or expired token. Command `forbidden` is not in
  the command set. `delivery_unavailable` is not in either set.
- Window arithmetic, for typed errors: checks at t0, t0+5m, t0+10m. `projectCredentialStopAt` keeps
  `max(start+10m, at + remaining*5m)`. Stop needs `checks ≥ 3` and `at ≥ start+10m`. A transient does not count and
  does not clear the window. A successful read, claim, or ack clears it. Stop aborts `sleep` (`defaultSleep` clears its
  timer and listener). Orderings confirmed→transient→confirmed→confirmed, confirmed→success, and confirmed→stop behave
  as the tests say.
- Supervisor: production passes no `restart` (grep: no call site sets `maxAttempts`). Fast delays are
  1/2/4/8/16 s × [0.5,1]. After that the delay is 150–300 s, clamped to 5 min (`sustainedListenerRestartMs`). The
  clean-run reset is ≥60 s after ready. `defaultRestartSleep` clears its timer on abort. `nextAttemptAt` is set while
  waiting and cleared on ready, stopped, and failed.
- There are no stopped or failed lapse notices (`listenerLapseNotices` `down` guard), and the JSON `listenerLapse` is
  false. The test covers only `state: "stopped"`, but the measured case was `failed`. The code handles both.
- No new branch on `error.message`. Every new test file is in `npm test` (literal list) or the `test:p1-cli` glob (sh
  passes the glob unexpanded, because `tests/p1-cli/*/` has no `.test.ts`, and node expands it).

## Not established

I did not run the suites. I did not run a live listener. I did not run the H0 edge. I did not check the effect of the
changed `hookSurfaceExists` JSON meaning on other readers of that field.

VERDICT: FAIL
