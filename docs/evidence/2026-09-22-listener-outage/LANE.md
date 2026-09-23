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

A successful read or claim clears the window and the listener is `ready` again. A transient failure (network, timeout, 5xx, or a 401/403 that is not a confirmed code) does not count as a check and does not clear the window. The stated stop time moves out by the remaining intervals. `cswarm listen stop` aborts the wait and the listener ends `stopped`. A locally known renewal horizon or a missing local secret still stops at once. A renewal HTTP credential answer enters the confirmation window; Fold 7 supersedes the earlier statement about all renewal stops.

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

## Fold 5

The delivery client now distinguishes a recognized command refusal from a response without a recognized error envelope. HTTP 400, 404, and 426 with an unrecognized envelope retry with capped delivery backoff. A 2xx non-JSON body or JSON without the accepted command envelope raises `DeliveryResponseError` and takes the same retry path. A recognized, well-formed `invalid_request` refusal remains fatal. Deeper accepted-envelope validation and local claim validation still raise `DeliveryProtocolError` and remain fatal. Claim status records `malformed_response` or `http_<status>` and the next attempt time; ACK status uses `ack_retry` with the same code and next attempt time. Both clear when the command succeeds.

### Claim and ACK stop paths

| Path | Class now |
|---|---|
| Caller stop during command or wait | `cancelled` immediately. |
| Missing or invalid local credential, or local renewal stop | `credential` immediately. |
| Confirmed command-edge `unauthenticated` | Credential confirmation window; `credential` only after its checks and time window. |
| H0 seat refusal | Fatal `ListenerH0SeatError` immediately. |
| Transport, 429, 5xx, or unconfirmed 401/403 | Capped retry. Claim forces a read after three refusals; ACK retains the prepared idempotent command. |
| HTTP 400/404/426 without a recognized command error envelope | Capped retry with `http_<status>` in status. |
| HTTP 2xx with non-JSON or a JSON body outside the accepted envelope | Capped retry with `malformed_response` in status. |
| HTTP 400/404/426 with a recognized, well-formed refusal code | Fatal, as before. A recognized 409 is likewise fatal. |
| Accepted envelope with malformed delivery row, count, capability, echoed ACK fields, or more than one claimed row | Fatal `DeliveryProtocolError`, as before. |
| Local request validation, journal reservation or write failure, incomplete prepared ACK, terminal-effect mismatch, or journal clear failure | Fatal local error, as before. |
| Unknown, untyped exception | Fatal, as before. |
| ACK `delivery_unavailable` after its lease has expired | Clear the stale prepared ACK and return to reads, as before. |

The read parser now raises `SignalMalformedError` when tolerated malformed rows exceed the limit or a present delivery capability marker is not exactly `1`. Both are classified as `malformed_response` and retry with capped read backoff. Invalid local `maxMalformedRows` configuration remains an ordinary fatal error.

The tests in `tests/listener-runtime.test.ts` cover HTML 200, foreign 404 and 400, and a JSON body without our envelope on claim, with persisted status and recovery; a foreign 400 after a push wake without an intervening read; HTML 200 and foreign 404 on ACK, with persisted status and recovery; the two malformed read cases; and a recognized 400 mutation control. Every new runtime test has a 15-second timeout. `tests/listener-control.test.ts` supplies the new retry-delay event field. A detached CLI listener against a loopback fixture read a durable-capability page, then received foreign 404 claim answers. Its `claim_retry` status named `http_404` and the next attempt; the status JSON is [fold5-detached-status.json](fold5-detached-status.json). The fixture listener was stopped. That product test has a 20-second timeout. All three files run in `npm test`.

Mutation: forcing `isForeignDeliveryHttpResponse` false made the foreign-claim recovery test fail (`failed` instead of `stopped`, exit 1), while the recognized-400 control passed in the same invocation. Restoring the condition made both pass (exit 0).

Final gates used a temporary HOME and unset `FORCE_COLOR` for both test suites:

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 923 tests: 921 passed, 2 failed, 0 skipped. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 827 tests: 824 passed, 3 failed, 0 skipped. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI bundle built and execute-checked. |

The two `npm test` failures were `resume-process-table.test.ts` and `resume.test.ts`. The CLI suite also failed `unknown-flag-message.test.ts`. Each failure came from this sandbox denying `ps` with `spawn EPERM` or `spawnSync ps EPERM`. The isolated listener runtime, control, and delivery-client files passed 169/169. The detached foreign-claim product test passed separately (1/1).

No live workspace or production edge was contacted. This fold did not establish behavior against a deployed command or read edge.

## Fold 6

The two exported fatal-answer constants are `READ_FATAL_ANSWERS` and `COMMAND_FATAL_ANSWERS` in `src/listener/runtime.ts:153-176`. An HTTP answer outside these exact `(status, error)` pairs retries, including 405, 408, 409, 413, 421 and 422 without a recognized envelope. An unexpected page field retries as `malformed_response`. The credential members enter the existing three-check, ten-minute window before a stop. Local journal, effect, and credential-state failures still stop by their typed paths (`runtime.ts` `sendPreparedAck`, `validateClaimResult`, and `isLocalCredentialLoss`); they are not inferred from an HTTP status.

| Edge | Fatal member | Source of the edge answer |
|---|---|---|
| Read | 401 `unauthenticated`; 403 `forbidden` after confirmation | `supabase/functions/read/index.ts:471,475` |
| Read | 400 `invalid_request` | `supabase/functions/read/index.ts:409` |
| Read | 404 `channel_not_found` | `supabase/functions/read/index.ts:770` |
| Read | 405 `method_not_allowed` | `supabase/functions/read/index.ts:384` |
| Read | local `delivery_configuration_missing` | `src/listener/runtime.ts:816-820`; the edge advertises both delivery capabilities on its successful page |
| Command | 401 `unauthenticated` after confirmation | `supabase/functions/command/index.ts:8915,8925` |
| Command | 400 `invalid_request` | `supabase/functions/command/index.ts:11189` |
| Command | 409 `command_id_conflict` | `supabase/functions/command/index.ts:9374,11079` |
| Command | 409 `delivery_ack_conflict` | `supabase/functions/command/index.ts:11397` |
| Command | 409 `delivery_not_surfaced` | `supabase/functions/command/index.ts:11404`; status from `src/cloud/session-wire.ts:156` |
| Command | 413 `payload_too_large` | `supabase/functions/command/index.ts:1405,1420,9091` |
| Command | 403 `h0_seat_uses_poll` | `src/cloud/delivery.ts:82` names the expected fence. **No edge producer of this slug exists in this checkout**; the edge source cannot be cited here. The classifier and test preserve the existing H0 contract, but the live edge behavior is unestablished. |

`session_proof_missing`, `session_proof_invalid`, and `session_expired` originate in `supabase/functions/_shared/agent-auth.ts:231-290`; the command fence returns them at `supabase/functions/command/index.ts:8927-8943`. `session_conflict` is also possible there. They retry and status tells the operator to start or renew the seat session, or stop the listener. `CONNECTED` is no in claim and ACK retry states. A read failure after ready, including a forced read after claims or ACKs, records its code and the next attempt. The 60-second notice says to leave the running listener in place.

The retry cap is 30 seconds with a 15-second minimum at the cap. A lasting read outage therefore emits about two to four status writes and two to four log lines per minute per listener. A lasting claim or ACK outage emits about two to four retry writes and lines per minute, plus a forced read every third refusal and any read-failure event. `events.ndjson` has no total-size limit.

Proving tests: `tests/listener-runtime.test.ts` covers all six foreign statuses on both read and claim paths, malformed pending count, every fatal pair, all managed-session codes, forced-read status, and repeated ACK failures with backoff surviving the read. `tests/listener-control.test.ts` covers a ready listener's read retry headline and target URL. `tests/listener-cli-process.test.ts` starts a detached listener against a local stub on a temporary state directory, records [fold6-detached-status.json](fold6-detached-status.json) in `claim_retry` with `http_405` and a next attempt, then stops it. No real workspace or model was used.

Mutation control: forcing HTTP 405 into the command fatal check made the foreign-claim test fail while the foreign-read positive control passed (exit 1, one pass and one failure). After restoring the classifier both passed (exit 0). This proves the command test reaches the changed decision.

### Fold 6 gates

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 930 tests: 928 passed, 2 failed. Both failures call `ps` and received sandbox `spawn EPERM` (`resume-process-table`, `resume`). |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 827 tests: 809 passed, 18 failed. Three `ps` denials (`resume-process-table`, `resume`, `unknown-flag-message`); seven protected-home writes were denied; eight child CLI assertions received the sandbox's unavailable-credential-store warning. This gate ran before the final two focused listener tests; those tests and the citation-drift test passed separately afterward. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI built and execute-checked at version 0.1.72. |

The requested range `git diff --check a9846955...HEAD` is recorded after the fold commit. No hosted edge or production box was contacted. No live workspace behavior was established. The H0 edge producer is absent from this checkout, so its live refusal was not established here.

## Fold 7

This fold closes the response-parser class of failures. A network answer with malformed content now produces a tagged, retryable malformed error. Local request validation and journal/effect inconsistencies retain their local fatal classes. A full read page with no safe cursor is checked inside the read retry handler, before effects from that page run. A recognized renewal `401 unauthenticated` is a command-edge credential sample and enters the three-check window. Foreign renewal answers, including HTML 404, retry with capped backoff and leave the credential session able to renew later. While retrying, status records `renewal_retry`, the current token's expiry, and the next attempt. After that known expiry, a still-unknown renewal outcome becomes a local expiry stop; a recognized credential answer still goes through the window. The listener only retries that renewal in listener mode; one-shot CLI commands may use a still-live predecessor. A recognized command `426 upgrade_required` is fatal with installer and npm update commands and a restart action, including on renewal. Read `405 method_not_allowed` now retries because an intervening redirect can turn the client's POST into GET. All four ACK session-proof codes name the session action in status. The failed credential state retains the answering edge and keeps the credential code names in its sentence.

### Response throw-site audit

The locations below are line numbers in this fold's sources. Each listed throw is in a network-response parser or its validating helper. The structural AST test starts at the read-page and directory parsers, claim and ACK parsers, accepted-envelope parser, and renewal response parser, follows their same-file helper calls, and fails on `throw new Error` or a delivery parser's `throw new DeliveryProtocolError`. Local caller-input checks are outside those parser roots. The tagged classes are:

| Surface | Response throw sites | Class and retry route |
|---|---|---|
| Signal page | `checkedUuid` 275; `checkedBoolean` 286; `checkedTimestamp` 293; `deliveryCapabilityMarker` 309; `pendingDeliveryCountOf` 344; `parseSignalRecipients` 403, 410, 423, 427; `parseSignalRecord` 476, 489, 499; `parseSignalRows` 592; `plainMalformedError` 266 (returned and thrown by callers) | `SignalMalformedError`; `malformed_response` read retry. |
| Signal directory | `parseAgentMemberRow` 1322, 1326, 1329, 1333; `parseMemberRow` 1348, 1352; `parseAgentIdentity` 1362, 1366, 1373; `readAgentSignalDirectory` malformed body 1422, 1426, malformed agents 1435 | `SignalMalformedError`; tagged malformed response. The directory's transport sites 1410, 1415 use `SignalTransportError`. |
| Full page cursor | `runtime.ts` after `requireCapabilities` | `SignalMalformedError`; caught before effects, then `malformed_response` read retry. |
| Claim/ACK | `checkedUuid` 320; `checkedRfc3339Timestamp` 352, 358, 376, 385, 392; `checkedLiveLease` 402; `checkedRelation` 413; `checkedNonNegativeCount` 423; `checkedClaimCapabilities` 433, 440; `checkedOptionalUuidArray` 455; `checkedOptionalArray` 465; `checkedRecipientSlot` 488, 498; `parseDeliveryRow` 512, 521, 526, 540, 545; `parseClaimSuccess` 579, 583, 591, 602, 608, 615, 628, 636; `parseAckSuccess` 652, 658, 665, 670 | `DeliveryMalformedResponseError` (subclass of `DeliveryResponseError`); `malformed_response` claim/ACK retry. `successBody` 767, 774 already throws `DeliveryResponseError` and retries. |
| Renewal | `requestSuccessor` malformed JSON/object and principal 426, 431, 435; command status/reason 459, 462, 473, 530; accepted successor fields 534, 538, 545, 551, 556, 563, 569, 573, 579 | `RenewalMalformedResponseError` (subclass of `RenewalOutcomeUnknown`); listener `RenewalRetryError` and capped retry. Transport/unknown outcome 403, 407, 415, 446, 450, 455 uses `RenewalOutcomeUnknown`. Recognized credential answer 444 uses `RenewalCredentialCheckError`; the recognized version gate 452 uses `RenewalUpgradeRequiredError`. Known domain rejections use their distinct refusal classes; locally established grant and lineage stops retain their existing classes. |

The independent fatal-pair test lists expected edge answers separately from `READ_FATAL_ANSWERS` and `COMMAND_FATAL_ANSWERS`. It includes `426 upgrade_required` from `supabase/functions/command/index.ts:9122-9135`. The H0 fence producer now exists on `origin/main` at `supabase/functions/command/h0-seat.ts` (`H0_SEAT_CLAIM_REFUSED`); this branch has not merged main, so Fold 6's no-producer observation describes only that older checkout.

Proving tests: `tests/listener-runtime.test.ts` exercises malformed claim pending count, a full read page with a malformed last row, real `AgentCredentialSession` renewal 401 and foreign 404 through the runtime, renewal status and expiry through the supervisor, the independent fatal-pair set and `426` stop sentence, read 405 recovery, and ACK status for each session code. `tests/p1-cli/renewal-refusal-cause.test.ts` exercises recognized and foreign renewal answers, continued renewal attempts, and tagged malformed successors. `tests/listener-cli-process.test.ts` starts a detached listener against a loopback read/command fixture, records [fold7-detached-status.json](fold7-detached-status.json) with `failed` and `upgrade_required`, and stops it. It started no model and contacted no real workspace. Every new test has a timeout.

Mutation controls, each in one invocation with a positive control: changing the recognized renewal 401 branch to `RenewalRevoked` failed the window test while the foreign 404 test passed (exit 1, 1 pass/1 fail); changing a delivery parser throw to plain `Error` failed the AST test while the read 405 test passed (exit 1, 1 pass/1 fail); removing the 426 fatal member failed the independent pair test while the ACK test passed (exit 1, 1 pass/1 fail). Source bytes were restored after each mutation.

### Fold 7 gates and limits

The final source state was checked with an isolated temporary home and `FORCE_COLOR` unset for the test suites. The required gates returned these real exit codes:

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 940 tests: 938 passed, 2 failed, 0 skipped. The failures were the real `ps` and real resume process-table checks; this sandbox denies `ps` with `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 818 tests: 815 passed, 3 failed, 0 skipped. The failures were real `ps`, real resume, and whoami's `ps` check; this sandbox denies `ps` with `spawn EPERM` or `spawnSync ps EPERM`. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI built and execute-checked at version 0.1.72. |

The isolated home prevented tests from reading or writing the real `~/.cswarm` and `~/.config/cswarm` paths. An earlier unisolated suite invocation failed on protected-home `EPERM` writes and the resulting credential-store warnings; the final suite above is the isolated measurement. The detached product test used a temporary `--state-dir`, wrote the redacted status artifact linked above, and stopped its local fixture listener. This fold did not establish a green full-suite result where `ps` is available, a production release, or behavior against a real workspace or hosted edge. No production host or real workspace was contacted, and no merge from main was made.

## Fold 8

Fold 7's renewal classification applies only when `listenerMode` is true. One-shot `requestSuccessor` and `AgentCredentialSession.bearer()` again distinguish a locally expired predecessor (D-004) from an unexplained live 401/403 refusal (D-011), and give the original remedy verbatim. A named revocation still outranks local expiry. A one-shot 426 says to update cswarm and run the command again; the listener's 426 says to update and restart the listener. `inbox --follow` recognizes `RenewalCredentialCheckError` as a credential failure. Named `renewal_unsupported` and device refusals retain their own fatal classes and actionable sentences in listener mode.

The renewal credential window now retries every `RENEWAL_WINDOW_RETRY_MS` (30 seconds) while the predecessor is live, with `RENEWAL_WINDOW_EXPIRY_MARGIN_MS` (five seconds), instead of taking its five-minute confirmation sleep before another renewal attempt. The stop still requires at least three confirmed samples spanning `CREDENTIAL_LOSS_CONFIRM_WINDOW_MS` (ten minutes). A successful read or claim clears the window; it is evidence that the current credential works. While renewal is unresolved, reads and claims pause because a successor may already have been issued. The renewal retry status states that pause and says the listener ends at expiry if renewal does not succeed. This supersedes the Fold 7 sleep assertion: old wording expected exactly `CREDENTIAL_LOSS_CONFIRM_INTERVAL_MS` after the first renewal 401; new wording expects `RENEWAL_WINDOW_RETRY_MS` while the token remains live, so a recovering edge can renew before expiry.

The detached-process test exposed the missing production link: `src/cli.ts` wraps the live `AgentCredentialSession` to persist its token, and that wrapper originally exposed `bearer()` but not `expiry`. The runtime therefore could not select the short retry, and its first 401 stayed in `credential_check` past the eight-second test token's expiry. The wrapper now forwards the live expiry. The same detached fixture then accepted a successor on its second renewal answer before the old token expired, returned to `ready`, and was stopped. Its redacted [fold8-detached-renewal-status.json](fold8-detached-renewal-status.json) records `ready` with no error or credential stop.

Lease deadline and replay contradictions now carry `ListenerLeaseResponseError`, rather than plain `Error`. Attachment parsing carries `SignalAttachmentMalformedError`, classified as a malformed read response. The parser graph test now walks returned error factories, arrow functions, methods, and the imported attachment parser. It explicitly exempts three already-tagged or callback-only constructions in `signals.ts`.

### Renewal refusal test inventory at `a9846955`

All 15 tests below were restored from `4bd26f53` into `tests/p1-cli/renewal-refusal-cause.test.ts`. Their old and new operator wording is identical; no original assertion was deleted or weakened. Fold 7's six newer tests remain in `tests/p1-cli/renewal-listener-samples.test.ts`, with five more cases added there, including foreign one-shot 401/403 bodies and the follow predicate.

| Test at `a9846955` | Fold 8 state | Wording |
|---|---|---|
| D-004: a credential past its own expiry is reported as expired, not revoked | Restored | Old = new: “past its own expiry”. |
| D-004: the expiry message does not deny a revocation it cannot see | Restored | Old = new: “revoked as well”. |
| a named revocation outranks local expiry, because re-issuing would fail again | Restored | Old = new: “what was revoked”. |
| D-011: an unexpired credential refused at 401 names neither cause | Restored | Old = new: “does not say why”. |
| D-011: a null expiry names neither cause rather than guessing | Restored | Old = new: “does not say why”. |
| D-011: the unexplained refusal still gives a remedy, and asks without asserting | Restored | Old = new: “Ask whoever runs this workspace … whether this agent's access was changed.” |
| a server-named revocation at HTTP 200 still reports revocation | Restored | Old = new: named revocation remedy. |
| a server-named expiry at HTTP 200 keeps its own stronger message | Restored | Old = new: “expired before it could renew itself”. |
| 403 is treated exactly as 401 | Restored | Old = new: local expiry sentence. |
| D-004 reaches production: bearer() on an expired credential reports expiry | Restored | Old = new: local expiry sentence through `bearer()`. |
| D-011 reaches production: bearer() on a live credential names no cause | Restored | Old = new: unexplained refusal through `bearer()`. |
| class: the client asserts no cause it did not measure at 401/403 | Restored | Old = new: cause selection and exhaustive code map. |
| prose pin: the expired locally message is exactly the approved wording | Restored | Old = new: exact D-004 paragraph. |
| prose pin: the unexplained refusal message is exactly the approved wording | Restored | Old = new: exact D-011 paragraph. |
| prose pin: the named revocation message is exactly the approved wording | Restored | Old = new: exact revocation paragraph. |

The ACK retry test now sends every member of `DELIVERY_SESSION_PROOF_CODES` through the ACK path and checks the session action. The lease tests cover all three response contradictions, including both replay shapes. The near-expiry tests use a fake clock: one edge returns 401 twice, accepts renewal before the old expiry, and the listener reads after that expiry; another returns 401 throughout and stops only after the complete confirmation window. A third runtime test makes the first `bearer()` call return a confirmed renewal sample, then makes the still-valid token complete a read and verifies the window clears. Replacing the 30-second renewal retry constant with five minutes made the recovery test fail while the full-window stop test passed (exit 1, one pass and one fail); the source was restored and both passed (exit 0). Replacing one attachment parser throw with plain `Error` made the AST test fail while the full-window stop control passed (exit 1, one pass and one fail); restoring the source made the parser and both renewal-window tests pass (exit 0, three pass).

The citation drift test's seven `src/cli.ts` coordinates moved with this fold's imports. Its exact source-content assertions remain the same; only the line numbers were updated.

### Fold 8 gates and limits

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` with an isolated `HOME` | 1 | 945 tests: 943 passed, 2 failed, 0 skipped. Both failures call real `ps`, denied with `spawn EPERM` in this sandbox. |
| `env -u FORCE_COLOR npm run test:p1-cli` with an isolated `HOME` | 1 | 838 tests: 835 passed, 3 failed, 0 skipped. All three failures call real `ps`, denied with `spawn EPERM` or `spawnSync ps EPERM`. This is 11 above fold 6's 827. |
| `npm run check:tests` | 0 | Source and test type-check passed. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI built and execute-checked. |

The first suite runs used the ordinary home and had additional protected-home `EPERM` failures; the isolated-home results above are the final measurements. A detached fixture listener used a temporary `--state-dir`, stopped on an exact `426 upgrade_required`, and wrote [fold8-detached-status.json](fold8-detached-status.json): `state=failed`, `lastErrorCode=upgrade_required`, no pending attempt or credential stop. The renewed detached fixture also used a temporary state directory, wrote the ready status linked above, and stopped its local process. Both tests asserted that their status contains no agent token. No production host or real workspace was contacted. The fake-clock and detached recovery prove scheduling and successor adoption against a loopback edge, not a real DNS failover. These gates do not establish a fully green run on a host where `ps` is permitted.

## Fold 9

**Invariant A — listener deadline.** For a known, still-live token, every runtime sleep is capped at `expiry - RENEWAL_WINDOW_EXPIRY_MARGIN_MS`. The wake subscriber's wait horizon and the supervisor's restart backoff use the same deadline. The margin is 60 seconds: the renewal HTTP request has a 30-second timeout, and the other 30 seconds are a budget for client/server clock skew and response handling because the server judges expiry using its own clock. This is an engineering allowance, not a measured bound on every client clock; clocks more than 30 seconds apart remain outside this guarantee. The confirmation window retries at most every 30 seconds for *every* answer while the token is live, including a transient answer between confirmed 401s. Once the deadline is reached, it tries renewal again without a scheduled wait. Once the token has expired locally, the next failed renewal answer stops it locally; a confirmed 401 no longer waits out a ten-minute window for an already-expired predecessor. The credential-check status names the token expiry and next-answer stop when expiry precedes the projected confirmation stop. A live token is never permanently stopped on one `renewal_unsupported` or device refusal; those answers are retry samples. `426 upgrade_required` remains the named listener version stop.

**Invariant B — one-shot compatibility.** Outside listener mode, `bearer()` again warns and uses a live predecessor for `renewal_unsupported`, `renewal_grant_not_found`, device refusals, 426, and other non-fatal renewal answers. HTTP 400/404 latches renewal off for that session as at `a9846955`. One-shot parsing retains the base warning classes and messages for 426, other non-OK statuses, and unknown domain rejections. Revocation, suspension, reauthorisation, and an unrecoverable replay remain stops as at the base. The table test's outcomes were derived from `git show a9846955:src/cloud/renewal.ts`, not from this fold's implementation.

`ListenerLeaseResponseError` is now restartable by the supervisor. A contradictory or foreign lease answer still has a typed runtime stop, but the supervisor takes its bounded retry path. Local `DeliveryProtocolError` and journal inconsistencies remain non-restartable.

The property-style runtime test generates all 120 permutations of one confirmed 401, foreign 401, network error, 5xx and success, plus 64 three-failure sequences followed by success, at four lifetimes around lead time and expiry: **736 sequences**. It checks every pre-renewal wait against the deadline and 30-second retry cap, then checks successor adoption and a read before old-token expiry. A second property-style test generates **64 sequences** with confirmed and transient samples, then verifies that a credential stop has at least three confirmed checks and the complete ten-minute span. A separate expiry test verifies the next-answer stop. The one-shot table checks **20 renewal answers** and the 400/404 latch. The supervisor test checks the restart sleep against the same deadline.

Mutation controls: restoring a five-minute confirmation sleep made the generated recovery and confirmation tests fail (exit 1, two failures); restoring the fold-8 unconditional rethrow of `RenewalUnsupported`/`RenewalRefused` made the one-shot table fail (exit 1, one failure). Both source mutations were reverted and the focused tests passed. The detached loopback listener received a confirmed renewal 401, then an HTTP 500, then a successor before the old token expired. It reached `ready`; the redacted [fold9-detached-renewal-status.json](fold9-detached-renewal-status.json) was retained before the fixture was stopped. No real workspace or production host was contacted.

### Fold 9 gates and limits

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | 0 tests; TypeScript build passed. |
| `env -u FORCE_COLOR npm test` with an isolated `HOME` | 1 | 949 tests: 947 passed, 2 failed, 0 skipped. Both failures invoke real `ps`, denied by this sandbox with `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` with an isolated `HOME` | 1 | 838 tests: 835 passed, 3 failed, 0 skipped. All three invoke real `ps`, denied with `spawn EPERM` or `spawnSync ps EPERM`. |
| `npm run check:tests` | 0 | 0 tests; source and test types passed. |
| `bash scripts/build-release.sh` | 0 | 0 tests; single-file CLI built and execute-checked. |
| `git diff --check a9846955...HEAD` | 0 | 0 tests; see commit verification below. |

This fold does not establish a green `ps`-permitted full-suite run, behavior under real DNS failover, or a bound on production client clock skew. Immediate retries after the deadline have not been load-tested against an edge that answers immediately for the rest of the token's life. No release, merge, or production operation occurred.

## Fold 10

**Invariant C — request retry floor.** Runtime waits, wake waits, and supervisor restart waits have a named one-second minimum, `LISTENER_REQUEST_WAIT_FLOOR_MS`. A shared runtime gate also inserts the floor between distinct network calls when no loop wait intervened, including renewal-to-read and read-to-claim or ACK. The deadline cap cannot reduce a wait below that minimum, even in `[deadline, expiry)` or after local expiry. One second bounds a fast-failing listener to at most one retry request per second; it is short compared with the 30-second renewal timeout and keeps stop signals responsive. The cap is used only while a session can renew: it has a usable credential store, is not latched unsupported, and renewal is due. A null-store or latched session keeps its idle and wake cadence. The supervisor receives that same session predicate. Status records the next credential-check attempt and says when renewal is retrying in the last minute.

The renewal margin is **92 seconds**. Let **S = 30 seconds** be the allowed server-clock lead. `RENEW_TIMEOUT_MS` is 30 seconds. `2 × RENEW_TIMEOUT_MS + S + 2 × LISTENER_REQUEST_WAIT_FLOOR_MS = 92 seconds`: the first floor permits an attempt to start up to one second after the deadline, two renewal timeouts can then run, and the second floor separates those attempts. The second can still finish before a server clock S seconds ahead reaches expiry. This is an engineering bound for clocks no more than S ahead, not a measurement of production clock skew. After the deadline, the one-second floor applies to further attempts until renewal succeeds or the local expiry stop fires.

**Invariant B correction.** A one-shot 200 response with JSON body `null` follows `a9846955`: it warns and uses a still-live token. Listener-mode malformed-body handling remains explicit. After expiry, the listener stop says the credential expired before renewal completed; it does not claim the server was unavailable after a server answer.

The generated recovery test advances its fake clock by 20 ms for each renewal response, checks minimum spacing and a request-count bound in the deadline-to-expiry span, and covers 736 answer/lifetime orderings. It checks the renewal-to-read spacing too. A second generated test covers 64 sustained answer orderings through local expiry, including `renewal_unsupported`; each request advances the clock by 20 ms. It requires one final request after expiry and checks spacing and the margin count. The same test runs a healthy null-store listener through and beyond expiry. A claim test checks read-to-claim spacing. A supervisor test checks successive restarts after the deadline; the push-wake test checks spacing across immediate wake returns. These are stubbed requests, not real network load measurements.

Mutation controls were run with the source restored after each probe. Forcing `capWaitMs` to return zero after the deadline failed both generated tests (exit 1; 0/2 passed), then the restored source passed both (exit 0; 2/2). Removing the supervisor floor failed both restart tests (exit 1; 0/2 passed), then the restored source passed both (exit 0; 2/2). The detached loopback listener received a renewal 401, a 500, then a successor; it reached `ready`, and the fixture was stopped. Its token-free [fold10-detached-renewal-status.json](fold10-detached-renewal-status.json) was saved from the running process.

### Fold 10 gates and limits

| Gate | Exit | Count and result |
|---|---:|---|
| `npm run build` | 0 | 0 tests; TypeScript build passed. |
| `env -u FORCE_COLOR npm test` with an isolated `HOME` | 1 | 951 tests: 949 passed, 2 failed, 0 skipped. Both failures invoke real `ps`, denied by this sandbox with `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` with an isolated `HOME` | 1 | 838 tests: 835 passed, 3 failed, 0 skipped. All three invoke real `ps`, denied with `spawn EPERM` or `spawnSync ps EPERM`. |
| `npm run check:tests` | 0 | 0 tests; source and test types passed. |
| `bash scripts/build-release.sh` | 0 | 0 tests; the single-file CLI built and passed its execute check. |

This fold does not establish a green full-suite run on a host that permits `ps`, a bound on production clock skew, or the result of a real DNS failover. The rate tests use a 20 ms stub round trip and a fake clock. No release, merge, or production operation occurred.

One intermediate `npm test` run also had four unrelated ACP held-close timing failures under load (945/951 passed); each of those four tests passed alone, and the subsequent full suite returned to 949/951 with only the two `ps` sandbox failures.
