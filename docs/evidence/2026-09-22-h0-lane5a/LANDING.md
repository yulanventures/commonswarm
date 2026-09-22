# H0 lane 5a landing: poll, ack and the listener fence (2026-09-22)

Branch `lane/h0-poll-ack` from main `a103a512`, merged with `git merge --no-ff` onto main `844d0de2`. Nothing here is
deployed: the box still runs edge `94353b42`, and migrations `20260922000001`-`000003` are not applied there. The
Maker's record, with each fold's detail, is `LANE.md` in this directory.

## What it does

- **Fence.** The command edge's claim branch (the single caller of `claimAgentInbox` for listeners) refuses an H0 seat
  with 403 `h0_seat_uses_poll`; the ack branch still accepts that seat's ack; other seats are unchanged.
- **Poll** (`POST /functions/v1/h0/poll`, bearer only): the seat's own unacknowledged leases first, then new claims,
  at most ten, oldest first; a stable per-seat `listener_instance_id`; `ackBatch` closes the batch and changes no
  delivery state. A durable poll lock per seat and one active batch per seat, enforced by the schema.
- **One waiting poll for the whole deployment** (`H0_MAX_CONCURRENT_WAITS = 1`), counted and claimed under an advisory
  transaction lock, because the box edge runtime has four worker slots and a 50 s poll holds one. Others return at
  once with `retryAfterSeconds`. A client abort frees the slot; the wait never holds a transaction or a pool connection.
- **Lock order** in every poll transaction: the agent principal row (`FOR NO KEY UPDATE`), then the seat's lock row,
  then batch and delivery rows. The command edge's `claimAgentInbox` now also takes `FOR NO KEY UPDATE` on the
  principal (it was `FOR UPDATE`), so signal inserts' foreign-key KEY SHARE locks do not wait on a claim; claims,
  revokes and other principal updates still serialise with it (both arms listed every writer).
- **Ack** (`POST /functions/v1/h0/ack`): exactly the `AckAgentDeliveryCommand` field set through `ackAgentDelivery`.
  Lead ruling, accepted by the Strategist: the ack stays per message; the "effect ordinal" of SWARM-CLOUD.md:470 is the
  agent's `requestId` on its posts (lane 5b).
- **Retention.** Closed batches older than two days are purged by the pg_cron job `swarm-purge-h0-poll-batches`
  (migration `20260922000003`).
- **Box path.** `deploy/release-proofs/h0/` holds one catalog proof and one functional query per migration, to the
  contract in `deploy/RELEASE-TO-BOX.md` section 5. The restore helper `apply-h0-upgrade.sh` applies all five H0
  migrations and verifies the poll catalog exactly; the post-upgrade count check expects the purge job only when the
  baseline lacks it.

## Review (arms/)

| round | SHA | arm A | arm B | ruling |
|---|---|---|---|---|
| 1 | `bbee0033` | Codex FAIL (box path lacked the migrations; a dropped client held the only slot) | Opus PASS (11 RIGOUR) | fold 2 |
| 2 | `3dc812c9` | Codex FAIL (000003 not on the box path; unlocked slice check could hand one delivery to two polls) | Opus PASS | fold 3 |
| 3 | `f1ba1fb3` | Opus FAIL (post-H0 restore refused by an unconditional cron expectation) | Grok FAIL (lock-order deadlock slice vs second poll) | folds 4-5 |
| 4 | `6f4395c8` | Opus PASS (6 RIGOUR) | Grok FAIL, RIGOUR only (000001 proof ignored the index columns) | lead RIGOUR fold `d8c623a6`, land |

Makers: Grok (initial lane and folds 1-2), Codex gpt-6-sol (folds 3-5, in a workspace-write sandbox; the lead
committed folds 3 and 4 for it), the lead (citations and the last proof fix). From 2026-09-22 the arm model is a
Claude Opus 5.5 Checker plus the other of Grok and Codex (brain `operating-model` v11).

## Gates

At `6f4395c8` (lead, outside the sandbox): build 0; npm test 894 + 2 load-timing failures in files equal to the base
(`tests/support/host-stderr-exit-parity.ts`, `tests/p1-cli/timeout-table.test.ts`; each passed 2 of 2 alone, load
average 8-9); test:p1-cli 830 + the same timeout-table failure; check:tests 0; check:edge 0; test:p1-server 238;
test:h0-counts 16; test:h0-upgrade:local 0; build-release 0; diff-check 0. Mutation controls: without the slice's
`FOR UPDATE` the stalled-slice test failed (the stalled poll returned the delivery); the old lock order and the missing
partial-predicate check each failed their tests (Maker, fold 5); with the old 000001 proof the wrong-column test failed
(lead, `d8c623a6`). Merged tree (lead): build 0; npm test 897; test:p1-cli 832; check:tests 0; check:edge 0;
test:p1-server 234 + 4 gateway 502s in `tests/p1-server/file-artifacts.test.ts` (unchanged by this lane; 21 of 21 alone,
load average 10); test:h0-counts 16; test:h0-upgrade:local 0; build-release 0; site build 0; site test 566 + 1 (567 of
567 on a rerun); diff-check 0.

## Not established

- Whether a client disconnect reaches the worker's `request.signal` on the box: `deploy/edge-runtime/main/index.ts`
  calls `worker.fetch(forwarded)` with no signal. If it does not, an abandoned poll keeps the one waiting slot until
  its wait ends (50 s at most); others get `retryAfterSeconds`.
- Behaviour under the box's four workers and wall clock; nothing here ran on the box.
- The 503 `h0_transaction_retryable` answer has no test that reaches it; a lock timeout (`55P03`) still answers 500.
- A seat revoked in the short window after the principal lock can still receive a replay of leases it already holds
  (no new claim). Present since round 1.
- Register, ask, note, reply and working-on do not reach the command edge through h0 yet: lane 5b.
