- **PRODUCTION — `deploy/supabase-stack/migrate/apply-h0-upgrade.sh:20-22,68`:** The box upgrade path lists and applies only the two September 16 migrations. The poll code reads `swarm.h0_poll_locks` and `swarm.h0_poll_batches` (`supabase/functions/h0/poll-ack.ts:508,619`). If the edge code is released through this path, poll fails because those tables are absent. Nothing in this review establishes that the new migrations reached the box.

- **PRODUCTION — `supabase/functions/h0/poll-ack.ts:127-130,792-839`:** The wait timer does not use `request.signal`, and the loop checks only its deadline. If a client disconnects during a 50-second poll, that request can keep the sole waiting slot until the timer ends. Other seats then receive `retryAfterSeconds` while no client can use the held poll.

- **RIGOUR — `tests/p1-server/h0-poll-ack.test.ts:478-487,514-549,632-740`:** The tests replay a batch, set expiry in SQL, and run two live waits. They do not kill a worker between claim and response or during a wait. Those recovery paths are therefore not proved by this test file.

- **RIGOUR — `tests/p1-cli/h0-poll-contract.test.ts:159-170`:** The “removing the fence” test changes a source string, then checks a made-up response: `const bodyAfterRemoval = { error: "delivery_unavailable" }`. It never runs the changed claim path. The lane record describes a separate manual HTTP mutation, but this committed test does not prove its own claim.

The six pure tests in `h0-poll-contract.test.ts` passed. I ran no database test.

VERDICT: FAIL
