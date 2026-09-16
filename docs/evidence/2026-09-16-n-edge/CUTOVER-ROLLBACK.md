# N-edge cutover: stop and DNS rollback (2026-09-16, 22:12-22:14Z)

Steps 1-3 had succeeded (CUTOVER-STEPS-1-3.md: DNS on the box at 22:07:58Z, h0 path proof at 22:09:17Z, 14/14
controls). Step 4 (custom-domain deactivation) was never started.

## What tripped

At 22:12:19.7Z the lead session's UserPromptSubmit hook ran `cswarm check` (client 0.1.71) through
api.commonswarm.com, which then resolved to the box, and got `check_timeout`. Measured 5 times in a row through
the box: **5/5 `check_timeout`, 3.14-3.57 s**. The budget is `AGENT_CHECK_TIMEOUT_MS = 3_000`
(src/cloud/agent-check.ts:16); it covers the whole check (credential, directory read, inbox page read). Every
seat's turn hook runs this call, so every seat on a current client would stop seeing arrivals at turn time.

The step-3 control table had no `cswarm check` row. The h0 document (0.26 s, Strategist's measure) and the CLI
reads (members 2.73 s, feed 2.51 s, receipt 2.14 s) all have 30 s budgets, so none of them could show a 3 s
budget breaking.

Cause: each SQL statement costs one Falkenstein to us-east-1 round trip (108-113 ms TCP connect,
LATENCY-2026-09-16.md), and a check makes several requests, each opening a transaction with several setup
statements (BEGIN, SET TRANSACTION, three SET LOCAL) before any work.

## Rollback

Ruling (Strategist, 21:07Z): "a client timeout in production after the cutover is a stop and a rollback by DNS,
not a tuning session."

- 22:13:01Z: Cloudflare record for api.commonswarm.com set back to
  `CNAME ukezjcnxjvkpkeezxaew.supabase.co`, proxied false, TTL auto. Read back identical.
- Verification loop (h0 document is served only by the box; 404 means the box is off the path):

| time (Z) | h0 via api host | `cswarm check` |
|---|---|---|
| 22:13:11 | 200 (box) | exit 1, 3.14 s, check_timeout |
| 22:13:34 | 200 (box) | exit 1, 2.63 s, onboarding_failed (resolvers moving) |
| 22:13:57 | 403 | exit 1, 2.76 s, onboarding_failed (resolvers moving) |
| 22:14:19 | 404 (Supabase) | **exit 0, 1.32 s** |

- The lead's `cswarm inbox --notify` watcher read HTTP 403 twice during the transition (22:13:46Z, 22:14:01Z) and
  its loop restarted it; live again from 22:14:16Z.
- Nothing else to undo: the custom domain stayed active, GitHub needed no change. The edge container and Caddy files
  on yulan-vps-1 stay up and now serve only edge-staging.commonswarm.com.

## Wake proof taken during the window

Strategist ask 1e89a3b7: created_at 22:12:16.190Z (sent through the box), surfaced by the lead's monitor at
22:12:19.7Z, read at 22:12:29.9Z. Accepted by the Strategist.

## Ruling after the rollback (c05b6dda, 22:18:52Z)

A and B in parallel; the first gate to clear wins.

- A: fold the round trips server-side (the N-db lane's fold commit, pulled into its own edge lane), then measure
  EVERY client timeout constant through edge-staging with no production DNS. Second-cutover gate: at least 2x
  headroom at p95 over 20 runs for each, including `cswarm check` under its 3 s budget on the shipped 0.1.71 client.
  If A clears before 2026-09-18, re-cut the same way (DNS first, h0 proof, controls, hold at step 3).
- B: keep N-db prep moving to a rehearsed window; if that window is ready first, move functions and Postgres together
  and skip the interim.
- Either way, raise `AGENT_CHECK_TIMEOUT_MS` to a derived value with headroom in the next CLI release (3 s was tight
  even on Supabase: 1.3 s).
- Every control table from now on includes `cswarm check` and a listener wake round trip.

## Not established

- The per-request split of the 3.14-3.57 s (credential vs directory vs page read). The timeout-table lane measures it.
- How many seats hit a timeout during the 5 minutes on the box (22:07:58Z-22:13:01Z plus resolver caches). Seats
  retry on the next turn; no data was lost (a timed-out check does not advance its cursor).
