# H0 lane 5b landing: the h0 function forwards register, ask, note, reply and working-on (2026-09-22)

Branch `lane/h0-forward` from main `efe270c0`, merged with `git merge --no-ff`. Nothing here is deployed. The Maker's
record is `LANE.md` in this directory.

## What it does

- `POST /functions/v1/h0/register | ask | note | reply | working-on` parse exactly the fields the verb table
  (`src/h0/verbs.ts`) declares and call the command edge's own `handleRequest` IN PROCESS with a constructed request:
  the command edge's authentication, rate limits, idempotency (`requestId` -> `command_id`; `attemptId` for register) and
  audit run unchanged, and no second edge worker is used (the box has four). The join credential and the seat token
  travel only in the `Authorization` header of that internal request; nothing is fetched over the network.
- The command module starts `Deno.serve` only as the entry module, so importing it in the h0 worker starts no server.
- The h0 worker receives the command function's environment names except `SUPABASE_SERVICE_ROLE_KEY`
  (`H0_COMMAND_ENV_EXCLUSIONS` in `deploy/edge-runtime/main/router.ts`): no command h0 can send reads it.
- The agent document is generated from the verb table and now states the request-id pattern and the name length from
  the enforcing constants; a used or revoked seat's 409 defers to the response's message, which comes from shared
  constants in `supabase/functions/command/registration-conflicts.ts` (all three producers use them).
- `icon` is accepted and not stored; the document says so.

## Review (arms/)

| round | SHA | arm A | arm B | ruling |
|---|---|---|---|---|
| 1 | `7702e2b3` | Opus FAIL (the box h0 worker had no `SUPABASE_URL`: every forwarded verb would fail on the box) | Grok FAIL (the same; an HTTP forward holds two of the four workers) | fold 1: in-process call |
| 2 | `6cfb063e` | Opus PASS (RIGOUR R1-R7) | Grok FAIL (the document's 409 remedy differed from the edge's) | fold 2 |
| 3 (delta) | `2453ec6b` | Opus PASS (R1-R3, one-line each) | — | lead fixes `90da2b93`; land |

Maker: Codex gpt-6-sol (lane and folds 1-2); the lead made the last three one-line fixes.

## Gates

At `2453ec6b` (lead): build 0; npm test 897; test:p1-cli 839; check:tests 0; check:edge 0; test:p1-server 242;
build-release 0; diff-check 0. After `90da2b93`: the three touched pure test files 45 pass; check:edge 0;
`agent-join-credential` + `h0-forward` server files 39 pass. The merged tree is gated before the push.

## Not established

- Nothing ran on the box: the h0 worker's live environment, whether edge-runtime v1.73.13 reads `h0/deno.lock`, memory
  with the command graph loaded under the 96 MiB worker limit, and database connection headroom (at most three
  connections per h0 worker; the box's `max_connections` is not in the repo).
- The parity test compares `swarm.signals` rows only, not recipient or delivery rows.
- A serialization failure inside the command transaction is the command edge's 500 (only the h0 routing lookup uses
  the shared 503 classifier).
- The three-host done-test (spec section 1): after the box release.
