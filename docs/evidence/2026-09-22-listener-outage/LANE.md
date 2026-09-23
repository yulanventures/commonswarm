# Listener outage lane — 2026-09-22

Maker notes for `lane/listener-outage`. No production host was contacted. No listener was started against a real workspace. `~/.cswarm` and `~/.config/cswarm` were not read or written.

## What was measured on the mini

These facts were supplied. This lane did not re-read `~/.cswarm/listeners/*/status.json` or `events.ndjson`.

No listener on that host was running. Two had stopped for good on one short server problem:

- A listener (cswarm 0.1.64) stopped at 2026-09-16T22:14:10Z with `lastErrorCode` `credential_stopped` and `lastErrorDetail` `signal read failed (HTTP 403)`. The event was `listener_failed`, `restart_attempts` 0, `restartable` false. That was inside a five-minute DNS switch (22:08Z to 22:13Z), when `api.commonswarm.com` briefly pointed at a different backend. The credential was not revoked: the same seat still authenticates.
- Another listener stopped at 2026-09-18T15:52:02Z after `signal read failed (HTTP 500): internal_error`. It logged `listener_restarting` for attempts 1 through 5 within 24 seconds (delays 0.6 to 11.5 seconds), then `listener_failed` with `restarts_exhausted` true.

Nothing restarts a failed listener, so a 30-second outage ended coordination for that seat until a person noticed.

Status also reported `listenerLapse: listener_claim_throughput_lapse` for a listener that had already been stopped for six days, and `ATTENDING: hook` (`attendingSurfaces` `["hook"]`) after the hook had been removed from every settings file with `cswarm hook uninstall claude --write`.

## What changed

`CONFIRMED_CREDENTIAL_LOSS_CODES` in `src/cloud/signals.ts` is the only set of server `error` slugs that confirm a dead credential. Members:

- `unauthenticated` — unknown or expired. The read edge returns 401 `unauthenticated` when `agent_delivery_read_context` returns no row (`supabase/functions/read/index.ts` line 471). An expired token returns no row (`supabase/migrations/20260906000010_wake_delivery.sql` lines 398–400). The command edge returns 401 `unauthenticated` when `authenticateAgent` is null (`supabase/functions/command/index.ts` line 8915). `loadAgentCredential` returns null for a missing or expired token (`supabase/functions/_shared/agent-auth.ts` line 127).
- `forbidden` — revoked. The read edge returns 403 `forbidden` when `agent.is_revoked` (`supabase/functions/read/index.ts` line 475). The command edge returns 403 `forbidden` from `revoked()` on a non-delivery command (`supabase/functions/command/index.ts` line 9044).

`delivery_unavailable` is not in the set. The same command line uses it both for a revoked delivery command and for a route failure (`supabase/functions/command/index.ts` lines 9029 and 9044), so that slug does not confirm the credential is dead. A delivery acknowledgement that gets `delivery_unavailable` before the lease expires is retried. A revoked credential's next signal read still returns `forbidden` and stops.

A 401 or 403 without one of those codes, a network error, a 5xx, or a timeout is transient. The read loop retries it. If the runtime still returns a restartable stop, the supervisor does too.

Restart constants in `src/listener/supervisor.ts`:

- `LISTENER_RESTART_MAX_ATTEMPTS` = 5 (fast phase, not a give-up)
- `LISTENER_RESTART_INITIAL_MS` = 1000
- `LISTENER_RESTART_MAX_MS` = 60000 (fast-phase ceiling)
- `LISTENER_RESTART_SUSTAINED_MAX_MS` = 300000 (five minutes; the wait after the fast phase, for the life of the process)
- `LISTENER_RESTART_CLEAN_RUN_MS` = 60000 (a ready run this long clears the fast-attempt count)

Production does not pass `restart.maxAttempts`. An explicit `maxAttempts` is still a hard ceiling, used by older tests to bound a crash loop. `cswarm listen stop` aborts the backoff sleep and the listener ends `stopped`.

While it is waiting, status state stays `starting` (not `failed`) and `nextAttemptAt` records the next try. The rendered line says the listener is retrying.

A stopped or failed listener does not get the claim-throughput lapse, the port-exhaustion notice, or the "reads are still failing" notice. A recorded run of delivery failures still prints, because that alarm is why the listener is down. The first status line names `stopped` or `failed`.

`ATTENDING: hook` is true only when `listenerSettingsHookInstalled` finds this principal's hook in a Claude settings file now (`src/cli.ts`). A leftover hook-surface file, and the `hookSurfaceExists` flag taken from that file, do not count. `ATTENDED` still counts that file: once it has surfaced a message, status says the session hook has surfaced messages. `listen start` still treats a hook-surface file as an attendance surface through `listenerHookSurfacePresent`. That start gate was not changed.

## Status sentences

Credential stop, `listenerFailureMessage` and the failed-listener line. Before: "the agent credential expired, was revoked, reached its renewal horizon, or its grant was suspended; run cswarm whoami with this credential to see the grant state, then follow its next step". After: "the server refused this credential (unauthenticated or forbidden means revoked, expired, or unknown) or a local renewal stop fired. The listener has stopped and will not retry. Run cswarm whoami with this credential to see the grant state, then follow its next step". The two code names are `CONFIRMED_CREDENTIAL_LOSS_CODES.join(" or ")`.

Stopped listener that still had a claim-lapse in its read health. Before, the first line was `Listener LAPSE for agent …: listener_claim_throughput_lapse.` After: `Listener stopped for agent ….` then "This listener is stopped and is not reading signals. Start it again by piping the same agent credential into: cswarm listen start …".

Waiting through a transient failure. Before, the state was `starting` and the line was "This is still in progress. Confirm with: cswarm listen status …". After, the first line is `Listener retrying for agent ….` and the next line is "The last attempt failed (`code`). The listener is still running and will try again at `nextAttemptAt`. Leave it running. To stop it now: cswarm listen stop --workspace-id … --principal-id …". The "still in progress" line is still there for `starting`.

Failed for a non-credential reason. Added: "This listener failed (`code`) and is not reading signals. Read `logPath`, then restart it by piping the same agent credential into: cswarm listen start …".

`ATTENDING: hook` when the hook is gone and only the surface file remains. Before: `ATTENDING: hook.` After: `ATTENDING: none. Signals queue and nothing wakes the session.` `ATTENDED: yes` stays when that same file has surfaced a message.

## Tests and which script runs them

| Test | File | Script |
|---|---|---|
| Bare HTTP 403 retries and the read succeeds | `tests/listener-runtime.test.ts` | `npm test` (the file is named in the `test` script) |
| HTTP 403 `forbidden` stops with `credential_stopped` | `tests/listener-runtime.test.ts` | `npm test` |
| HTTP 500 past the fast attempts keeps retrying and recovers | `tests/listener-control.test.ts` | `npm test` |
| Stop during the backoff ends at once | `tests/listener-control.test.ts` | `npm test` |
| Attempt count resets after a clean run | `tests/listener-control.test.ts` | `npm test` |
| Stopped listener does not report a claim lapse | `tests/listener-host-limits.test.ts` | `npm test` |
| `ATTENDING: hook` is false when no hook is installed, and true when `settings.local.json` has it | `tests/p1-cli/listener-outage-attendance.test.ts` | `npm run test:p1-cli` (glob `tests/p1-cli/**/*.test.ts`) |

`tests/support/agent-receive-cli.test.ts` is also in `npm test`. Its follow classifier expectations were updated so a bare 401/403 retries and a confirmed code stops.

## Mutation

Both probes are in `tests/listener-runtime.test.ts`. Each undo was restored before the next one. After both restores, the two tests passed again (exit 0).

1. `isFollowCredentialFailure` was put back to treating every HTTP 401 and 403 as a credential stop. `unconfirmed HTTP 403 retries and recovers when the read succeeds` failed: the read was not attempted again. `HTTP 403 forbidden stops the listener with credential_stopped` still passed. The test process exited 1.
2. `isConfirmedCredentialLossCode` was forced to return false, so `forbidden` was not a confirmed code. The bare-403 test passed. `HTTP 403 forbidden stops the listener with credential_stopped` failed: the runtime stop was `cancelled`, not `credential`, after the read loop retried for 81.5 seconds. The test process exited 1.

## What this lane did not establish

A live listener was not run. That is the lead's to do: a detached listener on a temporary `--state-dir`, against a server this lane is allowed to use, including a 403 with no slug, a 403 `forbidden`, a 500 longer than the five fast attempts, and `cswarm listen stop` during the wait. This lane did not prove the behavior on the hosted workspace or on the box.

`listen start` can still treat a leftover hook-surface file as an attendance surface. Status no longer does.

A delivery command whose credential is revoked is answered with `delivery_unavailable`, the same slug as a route failure. That path retries. It becomes a permanent credential stop when a signal read returns `forbidden` or `unauthenticated`. This lane did not prove that a listener stuck in an acknowledgement retry reaches that read.

## Fold 1

A single confirmed code is no longer a permanent stop. After the first confirmed-loss answer the listener stays up in state `credential_check` and re-reads at `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS`. It stops with `credential_stopped` only when every counted check in the window was a confirmed-loss code, at least `CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS` of them have arrived, and the time since the first is at least `CREDENTIAL_LOSS_CONFIRM_WINDOW_MS`.

Constants in `src/listener/runtime.ts`:

| Constant | Value |
|---|---|
| `CREDENTIAL_LOSS_CONFIRM_MIN_CHECKS` | 3 |
| `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` | 300000 (five minutes) |
| `CREDENTIAL_LOSS_CONFIRM_WINDOW_MS` | 600000 (ten minutes), `(MIN_CHECKS - 1) * INTERVAL` |

A successful read or claim clears the window and the listener is `ready` again. A transient failure (network, timeout, 5xx, or a 401/403 that is not a confirmed code) does not count as a check and does not clear the window. The stated stop time moves out by the remaining intervals. `cswarm listen stop` aborts the wait and the listener ends `stopped`. A local renewal stop or a missing local secret still stops at once: those are not a server answer.

`forbidden` confirms a lost credential only on the read edge. On the command edge the only confirmed code is `unauthenticated`. `COMMAND_CONFIRMED_CREDENTIAL_LOSS_CODES` is that one-element list. `CONFIRMED_CREDENTIAL_LOSS_CODES` stays the read-edge list (`unauthenticated`, `forbidden`).

### 403 forbidden on the command and read edges

"Credential lost" here means the answer is the revoked, expired, or unknown credential check. A live credential that fails some other rule is not lost.

Read edge:

| Place | Credential lost? |
|---|---|
| `supabase/functions/read/index.ts:475` — `agent.is_revoked` after `agent_delivery_read_context` returned a row | Yes. This is the read edge's only 403 `forbidden`. |

Command edge. The HTTP body is `{ error: "forbidden" }` unless the row says otherwise.

| Place | Credential lost? |
|---|---|
| `command/index.ts:2753` `replayResult` — rejected `accept_invitation` replay | No. The caller authenticated. The invitation was rejected. |
| `command/index.ts:4711` `registerLoginDevice` — bearer is not a user credential | No. Wrong credential kind. |
| `command/index.ts:4776` `registerLoginDevice` — device missing, owned by someone else, or revoked | No. The human credential is valid. |
| `command/index.ts:4830` `createSelfServeWorkspace` — `self_serve_disabled` or `credential_kind_forbidden` | No. Feature gate or wrong kind. |
| `command/index.ts:5973` `registerAgentSeat` — join credential missing, revoked, or expired | Yes. That join credential is dead. The listener does not send this command. |
| `command/index.ts:5988` `registerAgentSeat` — the join credential owner's membership is gone | Yes. The join credential can no longer register. Not the listener's agent token. |
| `command/index.ts:6021` `registerAgentSeat` — exact-kind gate failed after the join credential was accepted | No. |
| `command/index.ts:6468` `mintAgentJoinCredential` — not a user credential | No. |
| `command/index.ts:6707` `revokeAgentJoinCredential` — not a user credential | No. |
| `command/index.ts:6747` `revokeAgentJoinCredential` — id missing or caller not permitted | No. |
| `command/index.ts:6925` `capabilityPreamble` — capability URLs disabled | No. |
| `command/index.ts:6930` `capabilityPreamble` — not a user credential | No. |
| `command/index.ts:6934` `capabilityPreamble` — identity not verified | No. The credential is valid. The email is not verified. |
| `command/index.ts:7001` `capabilityPreamble` — role is not owner or admin | No. |
| `command/index.ts:7108` `mintCapabilityUrl` — work item id is ambiguous | No. |
| `command/index.ts:7117` `mintCapabilityUrl` — work item not found | No. |
| `command/index.ts:7384` `revokeCapabilityUrl` — link missing or not permitted | No. |
| `command/index.ts:7567` `resumeRenewalGrant` — not a user credential | No. |
| `command/index.ts:7575` `resumeRenewalGrant` — identity not verified | No. |
| `command/index.ts:7698` `resumeRenewalGrant` — `swarm.resume_renewal_grant` returned a refusal code | No. |
| `command/index.ts:8897` `handleTransaction` — `register_agent_seat` with no join-credential hash | Yes. Nothing was presented that this command can authenticate. Not the listener's agent token. |
| `command/index.ts:9029` `handleTransaction` — route resolution failed. Delivery commands get `delivery_unavailable` instead | No. The credential authenticated and has no route. |
| `command/index.ts:9044` `handleTransaction` `revoked()` — membership or agent credential revoked. Delivery commands get `delivery_unavailable` instead | Yes, for a non-delivery command. The same slug is used by the rows above and below, so the client cannot treat command-edge `forbidden` as this check. |
| `command/index.ts:9182` — `declare_agent_model` without an agent credential | No. |
| `command/index.ts:9194` — renewal without an agent credential | No. |
| `command/index.ts:9245` — agent is missing the command's scope | No. |
| `command/index.ts:9258` — mint bindings are not valid | No. |
| `command/index.ts:9478` — `signals_seen` actor id is null | No. Auth succeeded and the actor id is missing. |
| `command/index.ts:9504` — signal is not eligible for a receipt. `human-receipts.ts` returns `status: "forbidden"` and this line writes the HTTP 403 | No. |
| `command/index.ts:9643` — `post_signal` target or reply is not eligible | No. `revoked()` has already passed. |
| `command/index.ts:10140` — file refusal whose `error` is `forbidden`, from `file-artifacts.ts` | No. The four sites are `fileVersionCreate` line 535 (workspace row missing), `fileVersionCommit` line 850 (someone else created the pending version), `fileTombstone` line 1165 (an agent tombstoning another principal's file), `fileRestore` line 1264 (an agent restoring another principal's file). |
| `command/index.ts:10842` — reducer class `authz` (`role_forbidden`, `credential_kind_forbidden`, and the other authz reasons) | No. `revoked()` has already passed. |
| `command/index.ts:10996` — rejected `accept_invitation` | No. |
| `command/index.ts:11207` `handlePostRequest` — `register_agent_seat` bearer missing or not a join credential | Yes. The join credential was not presented. Not the listener's agent token. |
| `command/index.ts:11227` `handlePostRequest` — a join credential used on another command | No. The join credential is the wrong kind for that command. |
| `command/index.ts:11500` `lockHumanManagedPrincipal` — not a user credential | No. |
| `command/index.ts:11524` `lockHumanManagedPrincipal` — principal or live membership missing | No. |
| `command/index.ts:11527` `lockHumanManagedPrincipal` — role is not owner or admin | No. |
| `command/index.ts:11695` `acquireAgentSession` — not an agent credential | No. |
| `command/index.ts:11880` `renewAgentSession` — not an agent credential | No. |
| `command/index.ts:11925` `releaseAgentSession` — not an agent credential | No. |

Because most of those command-edge answers are not a lost credential, and they share the slug with the one that is (`revoked()` on a non-delivery command), a command-edge `forbidden` does not open the confirmation window. A revoked agent token still fails the next signal read with read-edge `forbidden`, and that read is the check the window counts. `unauthenticated` remains a confirmed code on both edges: every command and read site that returns it is an authentication failure (missing bearer, unknown token, or expired token).

### H0 seat

`H0_SEAT_CLAIM_REFUSED_CODE` in `src/cloud/delivery.ts` is `"h0_seat_uses_poll"`. The comment names the edge constant `H0_SEAT_CLAIM_REFUSED` in `supabase/functions/command/h0-seat.ts` on `lane/h0-poll-ack`. The delivery error allowlist includes that constant, so a claim response with that slug is not collapsed to `unknown_error`. A listener that receives it stops with `lastErrorCode` `h0_seat_uses_poll`. It does not retry the claim and it does not enter the credential window. `isRestartableListenerStop` is false for that error.

### Status sentences

Credential check, while the listener is still running. First line: `Listener credential check for agent <principal>.` Next line: `The server refused this credential (unauthenticated or forbidden). The listener is still running and will stop at <credentialStopAt> unless the credential works again. Run cswarm whoami with this credential to see the grant state.` The two code names are `CONFIRMED_CREDENTIAL_LOSS_CODES.join(" or ")`. `<credentialStopAt>` is the ISO time written on the status.

Permanent credential stop. Unchanged from the section above: `the server refused this credential (unauthenticated or forbidden means revoked, expired, or unknown) or a local renewal stop fired. The listener has stopped and will not retry. Run cswarm whoami with this credential to see the grant state, then follow its next step`.

H0 seat, failed listener. `This seat is a link-joined (H0) seat that receives messages through the h0 poll, so a cswarm listener cannot serve it.` `listenerFailureMessage` returns that sentence for code `h0_seat_uses_poll`. The failed-listener line is the same sentence with a period.

### Tests and which script runs them

| Test | File | Script |
|---|---|---|
| Window constants are at least ten minutes and three checks; read `forbidden` confirms and command `forbidden` does not | `tests/listener-runtime.test.ts` | `npm test` |
| Confirmed `forbidden` for the whole window returns `credential` | `tests/listener-runtime.test.ts` | `npm test` |
| Confirmed codes for the whole window, live status says `credential_check` and the stop time, then `credential_stopped` | `tests/listener-runtime.test.ts` | `npm test` |
| A confirmed code then a successful read is `ready` again | `tests/listener-runtime.test.ts` | `npm test` |
| A 500 between confirmed codes keeps the window going and still reaches `credential` | `tests/listener-runtime.test.ts` | `npm test` |
| `cswarm listen stop` during the check ends `stopped` on the first read | `tests/listener-runtime.test.ts` | `npm test` |
| Repeated command-edge `forbidden` on claim does not become `credential` | `tests/listener-runtime.test.ts` | `npm test` |
| H0 claim stops once with `h0_seat_uses_poll` and the status sentence | `tests/listener-runtime.test.ts` | `npm test` |
| Claim parser keeps `h0_seat_uses_poll` | `tests/delivery-client.test.ts` | `npm test` |
| Delivery and command `forbidden` stay restartable; read `forbidden` does not | `tests/listener-control.test.ts` | `npm test` |

### Mutation

`holdCredentialWindow` was changed so the first confirmed-loss answer returned `credential` immediately. `a confirmed credential loss then a successful read keeps the listener running` failed: `assert.ok(reads >= 2)` was false, because the runtime stopped before the successful read. The test process exited 1. The condition was restored. The same test then passed.

### What this fold did not establish

A live listener was not run. No production host was contacted. This fold did not prove the behavior on the hosted workspace or on the box.

`cswarm follow` still stops on one confirmed read code. The confirmation window is the listener.

The H0 fence is on `lane/h0-poll-ack`, not on this branch and not on main. This client recognizes the code. It did not run that edge.

A command-edge `forbidden` from `revoked()` on a non-delivery command does not by itself open the window. The next signal read does. This fold did not prove that a listener whose only failing call is a command post reaches that read.

A local renewal stop still ends the listener at once.

## Fold 2

The real `readAgentSignalPage` path throws an HTTP-tagged plain `Error`. The listener now checks that typed status and server error code before classifying a local credential failure, so read-edge `401 unauthenticated` and `403 forbidden` enter the confirmation window. A bare 403 retries. A stub-fetcher test drives the real read path. Restoring the old routing made that test fail on the first 401 (`credential` instead of `cancelled`, exit 1); restoring the fix made it pass (exit 0).

After `LISTENER_CLAIM_REFUSALS_BEFORE_READ` (3) consecutive retryable claim refusals, the claim loop returns to a signal read. The listener records `claim_retry`, its code, and count while the refusal is active. A read-edge confirmed loss then enters the window; a successful read clears the claim retry state. The test drives repeated `403 delivery_unavailable` claims, verifies the forced read, and observes `credential_check`. The same checkpoint applies after a push wake's claim without a preceding read.

Retry status clears `nextAttemptAt` when the next supervisor attempt starts. A test queries the live control status inside that attempt. `listen start` recognizes `credential_check` and `claim_retry` as running, and can report a live listener as still starting or checking rather than calling a 120-second wait a failure. The credential-check sentence conditions its stop time on every remaining check confirming the loss and names the effect of a transient answer. Its code list comes from the read or command edge that answered; a command-edge check names only `unauthenticated`.

Status records the listener's project directory on start and uses it to check the installed Claude hook. The attendance test checks the hook with a different caller directory. Local credential-state absence now has `LocalCredentialSecretAbsentError`; arbitrary error wording cannot cause an immediate credential stop. The H0 sentence tells the operator to stop the listener and that no further listener action is needed for the seat.

Other read-response paths a foreign backend can produce now retry with capped backoff: HTTP 400, 404, and 426; a malformed success body such as HTML on 200; malformed read rows; and missing or inconsistent read-service capabilities (`sender_relation_capability_missing`, `cursor_capability_missing`, `delivery_capability_inconsistent`). The local `delivery_configuration_missing` capability error remains fatal. The real-response test covers 400, 404, 426 and HTML 200; the capability test covers a missing marker. Local errors such as invalid delivery journal state, ACP protocol/configuration failures, and an unknown untyped exception remain fatal. `cswarm inbox --follow` remains unchanged and still stops on one confirmed read code.

Superseded gate snapshot from the fold-2 sandbox: `npm run build` and `npm run check:tests` exited 0. Ten targeted tests for the new paths and classifiers, plus four changed-behavior and citation tests, exited 0. `bash scripts/build-release.sh` exited 0. The full `npm test` gate had 911 tests: 851 passed, 58 failed, 2 skipped (exit 1). The `npm run test:p1-cli` gate had 822 tests: 713 passed, 103 failed, 6 skipped (exit 1). Those counts are historical and are replaced by the fold-3 gate results below. In fold 2, the sandbox denied Unix/TCP control sockets, process spawning, and local-state access; three feedback tests asserted after their TCP fixture failed to bind. No detached listener could be started there. No production host was contacted and no real workspace listener was started.

`git diff --check a9846955...HEAD` and the working-tree `git diff --check` exited 0. `git add` could not create the worktree's `index.lock` under the parent repository `.git` directory (`Operation not permitted`), so this fold was left uncommitted there. The lead subsequently committed it as `9089681a`.

## Fold 3

The isolated `tests/listener-control.test.ts` run reached 34 passing tests and then hit the enforced 180-second wall limit. The next test, "D-051: one rejected write does not poison the rest of the supervisor's writes", returned `SignalHttpError(400)` as a supposedly terminal fixture. Fold 2 made that response restartable, and the test left the supervisor on the production default of unlimited retries, so the promise never settled. It now returns a terminal `AcpProtocolError` and has a 15-second test timeout. The new live-control test and all five new asynchronous runtime tests have 15-second timeouts. The isolated control file then exited 0 in 2.4 seconds: 49 passed, 0 failed, 0 skipped.

The fold-2 read-path mutation control was repeated with a temporary HOME. Removing the `followHttpDetails` exclusion from local credential classification made the stub-fetcher test fail on the first HTTP 401: actual `credential`, expected `cancelled` (exit 1). Restoring the exact source bytes made that same test pass (1 passed, exit 0).

Gates with a temporary HOME and `FORCE_COLOR` unset:

| Gate | Exit | Counts or result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 913 tests: 911 passed, 2 failed, 0 skipped. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 827 tests: 824 passed, 3 failed, 0 skipped. The 1,248-case command dispatcher baseline passed. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and executed. |
| `git diff --check a9846955...HEAD` | 0 | No whitespace errors. |

Both full suites' failures are confined to process-table checks: `tests/p1-cli/resume-process-table.test.ts` and `tests/p1-cli/resume.test.ts` in both suites, plus `tests/p1-cli/unknown-flag-message.test.ts` in the CLI suite. This environment rejects `ps` with `spawn EPERM` or `spawnSync ps EPERM`; a direct `ps` probe returned `operation not permitted`. The listener tests passed in the full `npm test` gate. This fold did not establish green full-suite gates in an environment that permits `ps`, a detached listener with a temporary state directory, or behavior on a hosted workspace. No production host or real workspace was contacted.

## Fold 4

The claim retry attempt and refusal count now survive a successful forced signal read. A retryable claim failure sleeps before the next forced read, and only a successful claim clears the count and resets the delivery backoff. This supersedes Fold 2's statement that a successful read clears claim retry state. The regression test runs healthy reads against permanent command-edge 503 and 403 `forbidden` responses. For both, the eight observed sleeps were 0.5, 1, 2, 4, 8, 16, 30, and 30 seconds; live status stayed `claim_retry` with counts 1 through 8, and no clear event occurred. Restoring the old forced-read reset made that test fail (1 failed, exit 1); restoring the exact source bytes made it pass (1 passed, exit 0).

Read retries now emit their code and next attempt before the first ready event. The supervisor persists the startup cause and retry time; `listen status` and `listen start` name the target URL and read edge version, and capability failures reach the specific read-edge update message. A test covers HTTP 400, 404, 426, HTML 200, and a missing sender-relation capability. A detached CLI listener against a loopback 404 fixture stayed in `starting` with `http_404`, a next attempt time, and one current read retry. Its status JSON was retained in [fold4-detached-status.json](fold4-detached-status.json). The fixture listener was stopped. It did not start a model or contact a real workspace.

One exported running-state constant now drives status parsing and the running checks in the CLI and supervisor. A local credential file mismatch has its own stop code and a local state-directory remedy. The H0 stop sentence says the listener has already stopped. Restart, stop, and fail transitions clear stale credential-check edge and claim retry count. A terminal credential sentence no longer guesses the answering edge after that field is cleared. Status reports `CONNECTED: no` during credential checks, distinguishes an unreachable server from a claim refusal, and does not point a 5xx claim failure toward credential checking. The status and transition tests pin these behaviors.

Final gates used a temporary HOME. `FORCE_COLOR` was unset for both test suites.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 917 tests: 915 passed, 2 failed, 0 skipped. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 827 tests: 824 passed, 3 failed, 0 skipped. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI bundle built and execute-checked. |

The two `npm test` failures were `resume-process-table.test.ts` and `resume.test.ts`. The CLI suite also failed `unknown-flag-message.test.ts`. Each failure came from this sandbox denying `ps` with `spawn EPERM` or `spawnSync ps EPERM`. The isolated listener runtime and control files passed 135/135; the detached 404 product test passed with a temporary HOME and state directory. This fold did not establish green full suites where `ps` is permitted, behavior against a real command or read edge, or production behavior. No production host, Supabase service, Vercel service, or real workspace was contacted.
