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
