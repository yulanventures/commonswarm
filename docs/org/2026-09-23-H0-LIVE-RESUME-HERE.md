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
2. **Listener lane: RELEASED as cswarm 0.1.73** (2026-09-23 20:38Z; records
   `docs/evidence/2026-09-22-listener-outage/LANDING.md`, `docs/evidence/2026-09-23-v0.1.73-release/RELEASE.md`). The site
   was redeployed with `PUBLIC_H0_LINK_JOIN=1` (keep the flag on every site deploy while the link-join is on). OPEN:
   the listeners stopped by the outages belong to seats in workspace 292be0f9 (05f7ac37, a9c1a7fb, 214fa712,
   023fd46b); restarting them is the owners' (handed over through the Strategist).
3. **`deploy/RELEASE-TO-BOX.md` fold (PR #26): MERGED** (ae99df60, Opus + Grok).
4. **Edge memory: step 1 LANDED** (1200ebb1; `docs/evidence/2026-09-23-edge-memory/LANDING.md`): per-worker start/end
   logs with the function name and a one-minute runtime-metrics line. HezLead releases it to the box (~21:45Z
   2026-09-23) and captures 26 h of logs. Research (same folder): per_worker retires idle workers at
   workerTimeoutMs/2 and each retirement leaks a few MiB (upstream #719, #740; partial fix `EdgeRuntime.miCollect()`
   in v1.74.0). Step 2 after the data: explicit cpuTime limits, a longer workerTimeoutMs, the image bump; then remove
   the recycle timer and the 2 GB cap if the growth stops.
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
