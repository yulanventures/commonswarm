# H0 lane 5a — poll, ack, and the listener fence

Branch `lane/h0-poll-ack` from `a103a512`. Nothing in this lane is deployed.

## Effect ordinal

`SWARM-CLOUD.md:470` wants a per-message ack keyed by message id and effect ordinal.
The message id is `signal_id` on `POST ack`. The effect ordinal is the agent's
`requestId` on ask, note, reply, and working-on. Lane 5b forwards those verbs.
This lane does not add an ordinal field to the ack wire. The ack field set stays
the `AckAgentDeliveryCommand` set.

## Fence

Code: `h0_seat_uses_poll`, constant `H0_SEAT_CLAIM_REFUSED` in
`supabase/functions/command/h0-seat.ts`.

Call: `supabase/functions/command/index.ts`, in the delivery block, only when
the kind is `claim_agent_inbox`. It runs before the idempotency replay and
before the only `claimAgentInbox` call. Ack is not refused. The h0 poll calls
`claimAgentInbox` directly and does not pass through this branch.

A principal is an H0 seat when `swarm.agent_join_attempts` names that principal
in the routed workspace.

Message: the seat receives messages through `POST /functions/v1/h0/poll`.
`claim_agent_inbox` does not deliver to it.

## Records

Migration `supabase/migrations/20260922000001_h0_poll_lock_and_batch.sql`.
Owner `swarm_admin`. RLS on. `swarm_command` may select, insert, and update.

`swarm.h0_poll_locks`

- Primary key `(workspace_id, principal_id)`.
- Holds `holder`, `listener_instance_id`, `acquired_at`, `expires_at`.
- Check: `expires_at >= acquired_at`.
- The writer sets expiry to the wait plus 5 seconds of cleanup plus 1 second.
  At a 50 second wait that is strictly longer than 50 seconds plus cleanup.
- Trigger `h0_poll_locks_guard` refuses delete and refuses a change to
  `listener_instance_id`.

`swarm.h0_poll_batches`

- Primary key `(workspace_id, principal_id, batch_id)`.
- Stores `lease_ids` (1 to 10), `status` (`active` or `closed`), `expires_at`,
  `closed_at`.
- Unique index `h0_poll_batches_one_active` on `(workspace_id, principal_id)`
  where `status = 'active'`. That is the unique-active constraint.
- Trigger `h0_poll_batches_guard` refuses delete and refuses a change to
  `lease_ids`. An active row may move `expires_at` earlier. Closing sets
  `closed_at`.

An expired batch is closed. Its stored lease ids are not written back onto
delivery rows. `claimAgentInbox` re-claims rows whose leases have expired.

## Poll and ack

Seat token in `Authorization: Bearer` only. A query credential is
`h0_bearer_query_refused`.

`POST poll` body, from `src/h0/verbs.ts` and `supabase/functions/h0/parse.ts`:

- `wait`, omittable, integer seconds, 0 to 50. Above 50 is `h0_poll_wait_refused`.
- `ackBatch`, omittable, the previous `batchId`. It closes that batch and
  changes no delivery column.

`POST poll` response:

- `batchId` (null when there is nothing to return)
- `listener_instance_id` (stable per seat)
- `deliveries` (own unacknowledged unexpired leases first, then newly claimed
  rows, at most ten, oldest first)

A second poll while the lock is held returns HTTP 409 `h0_poll_in_progress`.
The wait is `setTimeout`. It is outside every database transaction.

`POST ack` body: `signal_id`, `lease_id`, `listener_instance_id`, `outcome`,
`last_error_code`, and omittable `surfaced`. It calls `ackAgentDelivery`.

`POST ack` response: `ok`, `status: "accepted"`, `signal_id`, `outcome`.

Every h0 response sets `Cache-Control: no-store` and
`x-robots-tag: noindex, nofollow, noarchive`. Poll and ack do not send
`Access-Control-Allow-Origin: *`.

Database settings use the command names: `SWARM_DATABASE_URL`, else
`SUPABASE_DB_URL`, and `SWARM_DATABASE_TLS_CA_B64`.
`FUNCTION_ENV_NAMES.h0` lists those three. `supabase/functions/h0/deno.json`
maps `postgres` so local `functions serve` can load the delivery module.
The box bootstrap still copies `deploy/edge-runtime/h0-deno.json`, which has
the same map.

## Mutation

The refusal test was run with the fence return disabled
(`if (false && refusal !== null)` in the claim branch).

Command:

`env -u FORCE_COLOR node --import tsx --test --test-concurrency=1 --test-name-pattern "claim is refused" tests/p1-server/h0-poll-ack.test.ts`

Exit 1. The claim returned HTTP 200 and a delivery, where the test requires
HTTP 403. The condition was restored. `false && refusal` is not in the file.

## Tests and the script that runs them

- `tests/p1-cli/h0-poll-contract.test.ts` — `npm run test:p1-cli`. Not in the
  literal `npm test` list.
- `tests/p1-server/h0-poll-ack.test.ts` — `npm run test:p1-server`.

## Not established

- The running box does not yet pass these database names into the h0 worker.
  The names are listed in this tree. Deploy was not run.
- Four polls of 50 seconds can occupy all four edge workers. This lane adds
  no admission limit.
- `deploy/supabase-stack/migrate/apply-h0-upgrade.sh` still applies only the
  two earlier H0 migrations. This migration's path onto the box is not established.
- H0 poll and ack do not use the command edge's delivery rate buckets.
- Register, ask, note, reply, and working-on are not forwarded. That is lane 5b.
- No detached `cswarm listen` was started. The fence was measured through the
  command HTTP claim.
