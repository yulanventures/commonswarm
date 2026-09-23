# D-036 Checker (Claude Opus), round 4: lane/listener-outage @ 4bd26f53

Base a9846955. I read brief4, LANE.md through "Fold 6", both round-3 reviews, `git diff 84b62913...4bd26f53 -- src/`,
and the code at 4bd26f53 in the detached worktree: `src/listener/runtime.ts`, `src/listener/supervisor.ts`,
`src/listener/control.ts`, `src/cloud/delivery.ts`, `src/cloud/signals.ts`, `src/cloud/renewal.ts` and `src/cli.ts`. For
each fatal member I read its producer in `supabase/functions/read/index.ts`, `supabase/functions/command/index.ts`,
`supabase/functions/command/durable-delivery.ts`, `supabase/functions/_shared/agent-auth.ts` and
`src/cloud/session-wire.ts`. I ran one tsx probe from `/private/tmp/opus4-probe`. It imported the worktree `src` by
absolute path and used stub fetchers, a fake clock, an in-memory credential store and a temporary HOME. It made no
network call, and I deleted it. The worktree is clean. This file is the only file I left.

## Round-3 findings: status at 4bd26f53 (from the diff; the probe did not re-run each one)

| Round-3 finding | Status |
|---|---|
| Opus P1 / Grok F2: foreign 405/408/409/413/421/422 stopped for good | FIXED. The classifier is inverted. Only exact `(status, code)` pairs in `READ_FATAL_ANSWERS` / `COMMAND_FATAL_ANSWERS` (`runtime.ts:153-176`) are fatal, and a command pair also needs `recognizedEnvelope` (`runtime.ts:191-195`). The tests drive all six statuses on read and claim through the real clients. Probe control: a read 405 HTML retried. |
| Opus P2: a managed-seat claim session code retried as `unknown_error` with no next step | FIXED for **claim** only (`delivery.ts` `DELIVERY_SESSION_PROOF_CODES`, `cli.ts:5755-5757`). The ACK path does not have this fix (P3). |
| Opus R1: `listen start` blamed the read edge for any code | FIXED. `lastRetryEdge` comes from the error type (`supervisor.ts` `retryEdgeOf`), and `listenerStartPendingMessage` branches on it. |
| Opus R2: "check the target URL" named no URL | FIXED. `targetUrl` is stored, validated as a bare origin in `parseStatus`, and rendered. |
| Opus R3 / Grok F1: after ready, a read outage looked healthy | FIXED. `read_retry` sets code, edge and `nextAttemptAt` in every state. `CONNECTED` is no during a read episode, `claim_retry` and `ack_retry`. The 60-second notice says to leave the listener running. `credential_check_cleared` goes back to `claim_retry` while claims fail. |
| Grok F3: a malformed `pending_delivery_count` stopped the listener | FIXED. The parser now throws `SignalMalformedError` (`signals.ts:344` and siblings). |
| Grok F4: an ACK retry never returned to a read | FIXED. `ackReadDue` forces a read after every third ACK failure, and `ackAttempt` survives the read. |
| Grok R5 / R8: HTTP 500 recorded as `error`; no back-off floor | FIXED. `safeErrorCode` maps to `http_<status>`, and the jitter is 0.5-1.0 of the ceiling. |

## P1: PRODUCTION. One 401 or 403 on the credential-renewal command stops the listener for good, with no confirmation window

The listener's credential is an `AgentCredentialSession` with a store (`cli.ts` `agentSession`). The default agent token
lives one hour (`AGENT_TOKEN_DEFAULT_TTL_MS`, `src/protocol/workspace-commands.ts:17`), so `bearer()` renews it about
once an hour. The renewal POST goes to the command edge, and any 401 or 403 becomes `RenewalRevoked`:

```ts
// renewal.ts:471, :495
if (response.status === 401 || response.status === 403) {
  ...
  throw new RenewalRevoked("forbidden", UNEXPLAINED_REFUSAL_MESSAGE);
// renewal.ts:884 (bearer)
if (this.expired() || error instanceof RenewalRevoked) throw error;
```

The runtime routes that error as a **local** credential loss, which stops at once and is never restarted
(`runtime.ts:1470-1472` on the read path, `:1743-1745` on the claim path):

```ts
// runtime.ts:588-590
 * A local credential stop: renewal horizon, revocation the renewal client
 * already decided, or a missing local secret. These are not a server answer a
 * foreign backend can forge, so they do not enter the confirmation window.
```

That comment is false for `RenewalRevoked("forbidden")`. It is a single server answer. LANE.md:98 repeats the claim
("A local renewal stop ... still stops at once: those are not a server answer").

Probe, same runtime invocation with a positive control:

```
renewal POST 401 {"error":"unauthenticated"} (token 3 min from expiry, renewal due)
  -> stop credential, error RenewalRevoked, restartable false, requests ['/functions/v1/command'], events []
control: read POST 401 {"error":"unauthenticated"}
  -> events ['credential_check', 'sleep:300000'], stop cancelled (window opened, no stop)
```

This is the 2026-09-16 incident class. While DNS pointed at a backend with a different database, that backend answers
the renewal with 401 `unauthenticated`. A listener whose hourly renewal falls inside a 5-minute switch (about 5/54 of
listeners on 1-hour tokens) ends `credential_stopped` on that one answer. That is the outcome this lane exists to
remove.

A second variant is also a single answer. A foreign 400 or 404 on the renewal POST (for example an HTML 404 from a
wrong host) throws `RenewalUnsupported` (`renewal.ts:463`). `bearer()` then sets `this.unsupported = true` for the life
of the process (`renewal.ts:886`). Probe: after one HTML 404, six `bearer()` calls up to and past expiry made **one**
renewal request in total. The token then expires, and reads get 401. So the listener reaches `credential_stopped`
through the window, about 16 minutes after the wrong-host episode ended.

Fix: treat a renewal 401/403 as a confirmed-loss sample that goes through the same window (or as retryable while the
predecessor is still live). Accept `RenewalUnsupported` only for a recognized `400 invalid_request` from our edge, and
treat any other 400/404 as `RenewalOutcomeUnknown`. Correct the comment at `runtime.ts:588-590` and LANE.md:98. Add a
test that drives the real `AgentCredentialSession` through the runtime with a stub fetcher.

## P2: PRODUCTION. A recognized `426 upgrade_required` on claim or ACK retries for ever. Status gives no action and blames the host

The command edge applies its version gate to delivery commands. It answers
`426 {"error":"upgrade_required","min_client_version":...}` (`command/index.ts:9122-9135`). This client sends a
compiled-in `CLIENT_PROTOCOL_VERSION` (`delivery.ts:839`), so no retry by this process can change that answer. It is a
well-formed refusal from our edge. `upgrade_required` is in `DELIVERY_SERVER_ERROR_CODES`, so the envelope is
recognized. But the pair is not in `COMMAND_FATAL_ANSWERS` (`runtime.ts:164-176`), so `isRetryableDeliveryError`
returns true. At base a9846955 this answer was fatal (`isRetryableDeliveryError` allowed only 429/5xx).

Probe (supervisor plus runtime, fake clock, one simulated hour, reads succeed): 165 claims and 163 reads, state
`claim_retry`, code `upgrade_required`, and no stop. Rendered status:

```
Listener LAPSE for agent ...: listener_claim_throughput_lapse.
The claim failed (upgrade_required) 165 times. The command edge did not accept the claim. The listener is running and will try again at ..., reading signals after repeated failures.
WARNING [listener_claim_throughput_lapse]: ... Next: ... Cheapest checks first: load average (uptime), process count, memory pressure ...
```

When `min_client_version` is raised, every older listener delivers nothing for ever. Its status says it will try again,
names no action ("update cswarm, then restart the listener"), and sends the operator to check host load. This breaks the
brief's "nothing retries forever without status naming the cause and the operator action". It also breaks the fold-6
rule that a well-formed refusal from our edge that no retry can change is fatal.

Fix: add `[426, "upgrade_required"]` to `COMMAND_FATAL_ANSWERS`, give it its own stop sentence with the upgrade
action, and add a mutation-controlled test. Also consider command-edge `403 forbidden` on claim. It retries with "The
command edge did not accept the claim" and no action. Forced reads bound it only when the read edge also refuses.

## P3: PRODUCTION. An ACK refused with a session code retries for ever with no operator action. LANE.md says otherwise

The session fence covers `ack_agent_delivery` as well as the claim (`command/index.ts:8927-8943`). The ACK result can
also be `session_conflict` or `session_expired` (`durable-delivery.ts:652-653`, `command/index.ts:11411-11418`). When a
managed seat's session expires between a claim and its ACK, the ACK retries. Every third failure forces a read, which
succeeds. No claim runs while the journal holds the prepared ACK, so the loop never ends. The ACK sentence has no
session branch (`cli.ts:5760-5761`). Probe render of `ack_retry` with `session_expired`:

```
The delivery acknowledgement failed (session_expired). The inbox is waiting on this acknowledgement. The listener will try again at ... and read signals after repeated failures.
```

LANE.md:318 says of all four session codes: "They retry and status tells the operator to start or renew the seat
session, or stop the listener". That is true for claim only. The fold-6 test checks the claim sentence only
(`tests/listener-runtime.test.ts` "foreign claim answers ..."). Fix: use the same `DELIVERY_SESSION_PROOF_CODES` branch
in the ACK sentence, add an ACK test, and correct LANE.md:318.

## R1: RIGOUR. The read fatal member `405 method_not_allowed` can only come from something other than this client's request

Our read edge sends 405 only for a method other than POST (`read/index.ts:383-384`). This client always POSTs, and
neither client sets `redirect`, so fetch follows redirects. A 301/302/303 in front of the edge turns the POST into a GET,
and our edge then answers 405 `method_not_allowed`. A retry would succeed once the redirect is gone. Probe: read
`405 {"error":"method_not_allowed"}` gave `fatal`, restartable false, and no sleep. A 405 HTML control retried. The
command side retries the same 405 as `http_405`, because `method_not_allowed` is not in its vocabulary. I have not shown
a production redirect in front of `/functions/v1/read` (Caddy's automatic HTTPS redirect is 308, which keeps the method).
So the member fails the brief's "no retry can change" test only on reachability. Either remove it or set
`redirect: "error"` on both clients.

## R2: RIGOUR. `400 invalid_request` on both edges is fatal also under version skew

`invalid_request` comes before auth from strict `exactKeys` parsing on the read edge (`read/index.ts:209-296`, `:409`).
On the command edge it comes from validation (`command/index.ts:9085-9094`, `:11189`). A backend that runs a different
edge version (the incident was a different backend) can refuse a request shape this client sends. That stop is
permanent, and a retry after the switch would have worked. LANE.md states that this is a deliberate choice. I did not
show that any deployed pair of edge versions differs in this way.

## R3: RIGOUR. Other members are sound but have limits

- `404 channel_not_found`: the listener sends no channel, so our edge cannot send this to it. This member is harmless
  and never reached.
- `409 command_id_conflict`, `409 delivery_ack_conflict`, `409 delivery_not_surfaced` and `413 payload_too_large` are
  deterministic answers to the exact prepared body, and a replay of an idempotent command is not a conflict. They are
  sound. The journal keeps the prepared ACK, so a restart replays it into the same 409. That is visible, and it is
  outside this lane.
- `403 h0_seat_uses_poll` has no edge producer in this checkout. LANE.md discloses this.
- A claim-outage hour still raises `listener_claim_throughput_lapse`, whose next step points at host load even while
  state is `claim_retry` with a named code (see P2).

## Checked and correct

- Stop enumeration (`grep 'reason: "'` in `runtime.ts`): `cancelled` on abort in every wait. `credential` comes from
  `isLocalCredentialLoss` (see P1) or from a complete window of 3 checks and at least 10 minutes. `fatal` comes from an
  exact fatal pair, H0, `delivery_configuration_missing`, `DeliveryProtocolError`, or local journal, effect or
  validation errors. Any other network answer retries in process or is restartable (`isRestartableRuntimeError`,
  `runtime.ts:514-563`). `CommandHttpError` still uses the old 429/5xx/401/403 rule (`runtime.ts:537-542`). I found no
  runtime path that produces it apart from the credential window's type checks.
- Read-edge `forbidden` is only `agent.is_revoked` (`read/index.ts:474-475`). The session fence returns only the four
  codes in `DELIVERY_SESSION_PROOF_CODES` (`agent-auth.ts:214-280`).
- Load: probe claim outage with reads succeeding was 328 requests per simulated hour (about 5.5/min). The floored
  jitter gives 15-30 s at the cap. The credential window is one check per 5 minutes.
- Every changed test file is in the literal `npm test` list or in the `test:p1-cli` glob. The fold-6 read and claim
  tests go through the real clients with a stub `fetcher`, so they are not circular. The Maker's 405 mutation control
  is recorded.
- `cswarm inbox --follow` still stops on one confirmed read code. The reported incidents were listeners (disclosed).

## Not established

I did not run the package gates or the test files. I did not start a listener. My probes of P2 and P3 render status
from a supervisor-written `claim_retry` status; I made the P3 `ack_retry` status by editing that object, not by driving
a real ACK. I did not measure how many production listeners run 1-hour renewing tokens, or whether a managed seat's
session can expire between a claim and its ACK in practice. I did not show a production redirect for R1 or a version
skew for R2.

VERDICT: FAIL
