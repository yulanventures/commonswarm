# Resume here: H0 is live on the box; the listener lane is in review (2026-09-23)

Written by CSwarmDevLead (seat 4989ea3b). Newest resume file; it replaces `2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`
(kept as history; its "What is LIVE", "Box facts" and "Window hazard" sections still hold except where this file
updates them).

## What is LIVE (measured 2026-09-23)

- **Box edge** = `releases/30ba33f9` (command + h0 + router), released 04:22-04:28Z by Anvil under HezLead with
  `deploy/RELEASE-TO-BOX.md`; no rollback. **Box stack** current unchanged = `e38b499f`. Migrations `20260916000001-2`
  (ledger backfill) and `20260922000001-3` are applied; ledger 51 rows; exactly one new pg_cron job,
  `swarm-purge-h0-poll-batches`. Evidence: `docs/evidence/2026-09-23-h0-release/` (PR #25).
- **What H0 does live:** `GET /functions/v1/h0/agent-doc/<locator>`; `POST h0/register|ask|note|reply|working-on`
  (in-process call of the command handler); `POST h0/poll|ack`; the command edge refuses `claim_agent_inbox` from an
  H0 seat with 403 `h0_seat_uses_poll`; one waiting poll at a time for the whole deployment (four edge workers).
  Records: `docs/evidence/2026-09-22-h0-lane4b|lane5a|lane5b/LANDING.md`.
- **Site** = release `20260923T055505Z-3357dc746feb`, built with `PUBLIC_H0_LINK_JOIN=1` (Strategist ruling,
  2026-09-23 05:53Z): the app's "Add an agent" offers the link-join invite. Rollback: redeploy with the flag unset
  (`deploy/site/deploy.sh commonswarm@100.115.66.74` from the main checkout); the previous release
  `20260922T162239Z-178190940341` is kept on the box.
- **CLI** released: 0.1.72 (unchanged).

## Open, in order

1. **H0 done-test (spec section 1): waiting for the operator.** Three hosts join from one pasted invite minted in the
   hub workspace (4f63d2b0). Ready: a watch that logs each new agent seat in the hub (lead scratchpad `h0watch/`),
   and a fence check (`claim_agent_inbox` with the H0 seat's token must return 403 `h0_seat_uses_poll`; a control
   with a fake token returned 401). If the done-test fails, redeploy the site with the flag off at once.
2. **Listener lane (`lane/listener-outage`, target 0.1.73), Strategist priority.** Found 2026-09-22: no listener on
   the mini was running; one stopped for good on a single 403 during the 09-16 DNS switch, one on a single 500. The
   lane has had 13 folds and 9 review rounds (Opus Checker + Grok); every round found a real case. The design now
   rests on stated invariants in its `LANE.md`: A (listener mode: no wait crosses the renewal deadline; a permanent
   credential stop needs a full window of confirmed samples from our edge), B (one-shot commands behave exactly as at
   `a9846955`), C (a 1 s floor between requests and on every wait), an explicit fatal-answer set per edge, and tagged
   malformed-response errors guarded by an AST test. Fold 13 (busy push listener false lapse; the stated retry time;
   turns end by the margin) is being made. **Blocker for the pair:** the Grok balance was exhausted (HTTP 402) until
   about 19:30Z on 2026-09-23; Codex made folds 2-13, so it cannot be the second arm. After the pair: the live
   control (script and fault proxy in the lead scratchpad `live/`: a detached listener on a temporary HOME, route
   main, through a local proxy that injects one 500 and one foreign 403 on the read path, against production), then
   release 0.1.73, then restart the stopped listeners one seat at a time, proving one wake round trip before the
   next, and tell each owning seat.
3. **`deploy/RELEASE-TO-BOX.md` fold (PR #26, HezLead):** the first run's procedure notes. Opus PASS on the delta;
   the Grok arm runs after its reset; merge after both.
4. **Edge memory (queue item after the listener release).** A one-minute series across 21:29Z-03:31Z
   (`/Users/yulanbot/Developer/Ridge.io/evidence/2026-09-23-commonswarm-edge-mem-series/`, HezLead): 192 MiB after a
   recycle to 896 MiB at 03:29Z (peak 920 of 2048); growth is not linear (+399 MiB in the first hour, then +20-104
   MiB/h); about 4.1 wall-clock early terminations per minute all night with almost no traffic; CPU 0.1-0.25%. The
   runtime logs only isolate ids on those lines. First step: log the function name for each worker in
   `deploy/edge-runtime/main/index.ts`, then find which function runs to the wall clock. Goal: remove the 6-hourly
   recycle timer and the 2 GB cap.
5. Then the queue the Strategist set: H, G, L, M, I, J, K, E, F.
6. **Cleanup of merged branches and worktrees:** still BLOCKED on the operator (rejected 2026-09-17, not answered).

## Model rules in force (brain `operating-model` v11)

Makers: Codex `gpt-6-sol` (only Maker until Grok's quota resets) or Grok 4.7; Claude is never a Maker. Pair: a Claude
Opus 5.5 Checker plus the other of Grok and Codex. Gemini is not a review arm. Codex Makers run with
`-s workspace-write` (network access and the repository `.git` added as writable roots); never
`danger-full-access`.

## Not established

- The H0 done-test itself (three hosts, one paste) and the live fence check on a real H0 seat.
- Whether a client disconnect reaches the h0 worker's `request.signal` on the box (`main/index.ts` passes no signal).
- The listener lane's behaviour during a real DNS failover; production clock skew.
